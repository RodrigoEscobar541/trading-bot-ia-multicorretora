// limiteLogin.test.js — o freio de tentativas do login do painel.
//
// O que estes testes guardam: um freio de login errado tranca o DONO fora do
// próprio painel, e o modo de falha mais provável não é o atacante passar (este
// freio nunca prometeu barrá-lo — ver o cabeçalho do módulo), é o dono legítimo
// não conseguir entrar. Por isso quase todo caso abaixo é sobre o freio SOLTAR.
// Rodar com: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  esperaSegundos,
  estadoLimite,
  registrarFalha,
  normalizar,
  mensagemErro,
  TENTATIVAS_LIVRES,
  ESPERA_INICIAL_S,
  ESPERA_MAXIMA_S,
  JANELA_ESQUECIMENTO_MS,
  ESTADO_ZERADO,
} from '../dashboard/public/limiteLogin.js';

const T0 = Date.parse('2026-07-25T12:00:00Z');

/** Erra a senha `n` vezes seguidas, sem deixar o tempo passar. */
function errar(n, agora = T0) {
  let estado = { ...ESTADO_ZERADO };
  for (let i = 0; i < n; i++) estado = registrarFalha(estado, agora);
  return estado;
}

test('as primeiras tentativas não bloqueiam — errar a senha uma vez é normal', () => {
  for (let i = 1; i <= TENTATIVAS_LIVRES; i++) {
    assert.equal(esperaSegundos(i), 0, `${i} falha(s) não deveria bloquear`);
    assert.equal(estadoLimite(errar(i), T0).bloqueado, false);
  }
});

test('passando das livres, a espera dobra a cada erro e para no teto', () => {
  assert.equal(esperaSegundos(TENTATIVAS_LIVRES + 1), ESPERA_INICIAL_S);
  assert.equal(esperaSegundos(TENTATIVAS_LIVRES + 2), ESPERA_INICIAL_S * 2);
  assert.equal(esperaSegundos(TENTATIVAS_LIVRES + 3), ESPERA_INICIAL_S * 4);
  // O teto existe para o freio não virar punição: sem ele, 20 erros dariam dias.
  assert.equal(esperaSegundos(TENTATIVAS_LIVRES + 40), ESPERA_MAXIMA_S);
  assert.equal(estadoLimite(errar(TENTATIVAS_LIVRES + 1), T0).faltam_s, ESPERA_INICIAL_S);
});

test('o bloqueio solta sozinho quando o tempo passa', () => {
  const estado = errar(TENTATIVAS_LIVRES + 1);
  assert.equal(estadoLimite(estado, T0 + 1000).bloqueado, true);
  assert.equal(estadoLimite(estado, T0 + ESPERA_INICIAL_S * 1000).bloqueado, false);
});

test('acertar a senha zera o castigo (o app grava ESTADO_ZERADO)', () => {
  assert.equal(estadoLimite({ ...ESTADO_ZERADO }).bloqueado, false);
  assert.equal(estadoLimite({ ...ESTADO_ZERADO }).estado.falhas, 0);
});

test('erro antigo não pune hoje: o contador esquece depois da janela', () => {
  const ontem = errar(TENTATIVAS_LIVRES + 3);
  const depois = estadoLimite(ontem, T0 + JANELA_ESQUECIMENTO_MS + 1);
  assert.equal(depois.bloqueado, false);
  assert.equal(depois.estado.falhas, 0); // recomeça pelas tentativas livres
  assert.equal(esperaSegundos(registrarFalha(depois.estado, T0).falhas), 0);
});

test('a janela de esquecimento não solta um bloqueio ainda em curso', () => {
  // Um bloqueio longo (teto) precisa sobreviver à checagem de esquecimento,
  // senão bastaria esperar a janela para o castigo evaporar antes da hora.
  const preso = { falhas: 40, ultima_falha: T0, bloqueado_ate: T0 + ESPERA_MAXIMA_S * 1000 };
  const meio = estadoLimite(preso, T0 + ESPERA_MAXIMA_S * 500);
  assert.equal(meio.bloqueado, true);
});

test('estado corrompido no storage NUNCA tranca o dono', () => {
  for (const lixo of [null, undefined, 'nada', 42, [], { falhas: 'muitas' }, { bloqueado_ate: 'sempre' }]) {
    const r = estadoLimite(lixo, T0);
    assert.equal(r.bloqueado, false, `${JSON.stringify(lixo)} não pode bloquear`);
  }
  assert.deepEqual(normalizar({ falhas: -5 }), { falhas: 0, bloqueado_ate: null, ultima_falha: null });
});

test('a mensagem de credencial não revela se o e-mail existe', () => {
  // Enumeração de conta: "senha errada" confirmaria que o e-mail é o certo.
  const senhaErrada = mensagemErro('auth/wrong-password');
  assert.equal(mensagemErro('auth/user-not-found'), senhaErrada);
  assert.equal(mensagemErro('auth/invalid-credential'), senhaErrada);
  assert.doesNotMatch(senhaErrada, /senha errada|não existe|não encontrad/i);
});

test('o bloqueio do SERVIDOR é explicado, não repassado como código cru', () => {
  const m = mensagemErro('auth/too-many-requests');
  assert.match(m, /Firebase/); // diz quem bloqueou
  assert.match(m, /minutos/); // e que passa
  assert.doesNotMatch(mensagemErro('auth/network-request-failed'), /auth\//);
  // Código desconhecido ainda aparece: melhor um código na tela que "erro".
  assert.match(mensagemErro('auth/coisa-nova'), /auth\/coisa-nova/);
});
