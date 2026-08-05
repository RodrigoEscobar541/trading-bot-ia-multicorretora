// firestoreRules.test.js — as regras do Firestore, testadas de verdade contra
// o emulador. NÃO roda no `npm test` (exige Java + emulador): use
// `npm run test:rules`.
//
// Existem por um motivo prático: regras do Firestore são avaliadas em OR, e um
// `allow` mais genérico anula qualquer tentativa de negar um caminho
// específico. É fácil escrever uma regra que PARECE proteger o segredo e não
// protege — e o erro só apareceria em produção. Aqui a garantia é executada.
//
// O outro risco é o oposto: enumerar caminhos e esquecer um, trancando o dono
// fora de uma tela. Por isso há um teste de leitura/escrita para CADA caminho
// que a dashboard usa (levantados de dashboard/public/app.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UID_DONO = 'COLE_AQUI_O_UID_DO_DONO';

// `firebase emulators:exec` define esta env. Sem ela não há emulador: os casos
// se PULAM em vez de falhar, para o `npm test` normal (e o CI, sem Java) seguir
// verde. Rodar de verdade: `npm run test:rules`.
const semEmulador = !process.env.FIRESTORE_EMULATOR_HOST;
const skip = semEmulador ? 'requer o emulador do Firestore — use `npm run test:rules`' : false;

// As bibliotecas de teste de regra são devDependencies e entram por import
// DINÂMICO, dentro do before. Import estático quebraria o `npm test` em
// qualquer ambiente que instale só as dependências de produção — foi o que
// travou o deploy da VPS em 2026-07-25: o teste era pulado, mas a importação
// no topo do módulo rodava assim mesmo e derrubava a suíte inteira.
let initializeTestEnvironment;
let assertFails;
let assertSucceeds;
let doc; let getDoc; let setDoc; let collection; let getDocs;

let env;
let dono;
let estranho;
let anonimo;

before(async () => {
  if (semEmulador) return;
  ({ initializeTestEnvironment, assertFails, assertSucceeds } = await import('@firebase/rules-unit-testing'));
  ({ doc, getDoc, setDoc, collection, getDocs } = await import('firebase/firestore'));
  env = await initializeTestEnvironment({
    projectId: 'regras-teste',
    firestore: {
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
      // Porta dedicada (firebase.json → emulators.firestore): a 8080 padrão
      // costuma estar ocupada por outra coisa na máquina de desenvolvimento.
      host: '127.0.0.1',
      port: 8079,
    },
  });
  dono = env.authenticatedContext(UID_DONO).firestore();
  estranho = env.authenticatedContext('outro-uid-qualquer').firestore();
  anonimo = env.unauthenticatedContext().firestore();
});

after(async () => {
  await env?.cleanup();
});

// ------------------------------------------------- o que o segredo garante

test('SEGREDO: o dono GRAVA dados/api mas NUNCA consegue lê-lo', { skip }, async () => {
  await assertSucceeds(setDoc(doc(dono, 'plataformas/MB/dados/api'), { mb_api_token_id: 'segredo' }));
  await assertFails(getDoc(doc(dono, 'plataformas/MB/dados/api')));
});

test('SEGREDO: o dono GRAVA global/telegram_token mas NUNCA consegue lê-lo', { skip }, async () => {
  await assertSucceeds(setDoc(doc(dono, 'global/telegram_token'), { bot_token: 'segredo' }));
  await assertFails(getDoc(doc(dono, 'global/telegram_token')));
});

test('o espelho SEM segredo (api_meta) continua legível — é o que a tela usa', { skip }, async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'plataformas/MB/dados/api_meta'), { mb_api_token_id: '…1234' });
  });
  await assertSucceeds(getDoc(doc(dono, 'plataformas/MB/dados/api_meta')));
});

test('listar a coleção `dados` NÃO é um atalho para ler o segredo', { skip }, async () => {
  // Uma query sobre a coleção inteira precisaria incluir `api`, que é negado.
  await assertFails(getDocs(collection(dono, 'plataformas/MB/dados')));
});

// ------------------------------- nenhum caminho da dashboard pode quebrar

const CAMINHOS_LEITURA = [
  'global/renda_real',
  'global/status_bot',
  'global/controle',
  'global/cambio',
  'global/config_renda',
  'global/regras_gerais',
  'global/relatorio_decisoes',
  'global/telegram',
  // Supervisão semanal (V7.2): a tela mostra a camada, a config e o prompt do
  // agente. Nenhum deles é segredo — mas o dono precisa LER os três.
  'global/supervisao',
  'global/supervisor',
  'global/supervisor_prompt',
  'plataformas/MB',
  'plataformas/MB/dados/estado',
  'plataformas/MB/dados/template',
  'plataformas/MB/dados/api_meta',
  'plataformas/MB/ativos/BTC',
  'plataformas/MB/ativos/BTC/dados/prompt',
  'plataformas/MB/ativos/BTC/dados/contexto',
  'plataformas/MB/ativos/BTC/dados/estado',
  'plataformas/MB/ativos/BTC/dados/dashboard',
  'plataformas/MB/ativos/BTC/dados/estatisticas_real',
  'plataformas/MB/ativos/BTC/dados/estatisticas_simulacao',
  'plataformas/MB/ativos/BTC/historico/h1',
  'plataformas/MB/ativos/BTC/operacoes/op1',
  'plataformas/MB/ativos/BTC/posicoes/pos1',
  'plataformas/MB/ativos/BTC/operacoes_manuais/m1',
];

test('o dono LÊ todos os caminhos que a dashboard usa', { skip }, async () => {
  for (const caminho of CAMINHOS_LEITURA) {
    await assertSucceeds(getDoc(doc(dono, caminho)));
  }
});

test('o dono ESCREVE nos caminhos que a dashboard edita', { skip }, async () => {
  const escrita = [
    'global/controle', 'global/config_renda', 'global/regras_gerais', 'global/telegram',
    // A tela da supervisão edita a camada, liga/desliga o agente e ajusta o
    // prompt dele; o "rodar agora" grava em `global/controle` (já acima).
    'global/supervisao', 'global/supervisor', 'global/supervisor_prompt',
    'plataformas/MB', 'plataformas/MB/dados/template', 'plataformas/MB/dados/estado',
    'plataformas/MB/ativos/BTC', 'plataformas/MB/ativos/BTC/dados/prompt',
    'plataformas/MB/ativos/BTC/dados/contexto',
    'plataformas/MB/ativos/BTC/operacoes_manuais/m1',
  ];
  for (const caminho of escrita) {
    await assertSucceeds(setDoc(doc(dono, caminho), { x: 1 }, { merge: true }));
  }
});

test('o dono LISTA plataformas e ativos (o menu depende disso)', { skip }, async () => {
  await assertSucceeds(getDocs(collection(dono, 'plataformas')));
  await assertSucceeds(getDocs(collection(dono, 'plataformas/MB/ativos')));
  await assertSucceeds(getDocs(collection(dono, 'plataformas/MB/ativos/BTC/operacoes')));
});

// --------------------------------------------------- ninguém mais entra

test('outro usuário autenticado não lê nem escreve NADA', { skip }, async () => {
  await assertFails(getDoc(doc(estranho, 'global/controle')));
  await assertFails(getDoc(doc(estranho, 'plataformas/MB/ativos/BTC/dados/dashboard')));
  await assertFails(setDoc(doc(estranho, 'global/controle'), { operacao_travada: true }));
  await assertFails(getDoc(doc(estranho, 'plataformas/MB/dados/api')));
});

test('anônimo não lê nem escreve NADA', { skip }, async () => {
  await assertFails(getDoc(doc(anonimo, 'global/status_bot')));
  await assertFails(setDoc(doc(anonimo, 'global/controle'), { operacao_travada: true }));
  await assertFails(getDoc(doc(anonimo, 'plataformas/MB/dados/api')));
});
