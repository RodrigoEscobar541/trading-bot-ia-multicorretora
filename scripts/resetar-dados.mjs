#!/usr/bin/env node
// resetar-dados.mjs — zera o histórico de operação para começar a medir do zero.
//
// POR QUE ISTO EXISTE: depois de muitas mudanças de prompt e de regra, os dados
// acumulados descrevem várias versões diferentes do sistema ao mesmo tempo e não
// respondem mais nada. Recomeçar exige apagar ~7.500 documentos espalhados por
// 15 ativos e reiniciar 6 documentos globais — à mão, no console, isso deixa
// resíduo, e o resíduo contamina justamente a medição que motivou o reset.
//
// NUNCA roda sozinho: não é chamado pelo bot, não tem agendamento, e sem
// `--executar` só imprime o que faria.
//
// USO:
//   node scripts/resetar-dados.mjs                          # simulação (não escreve nada)
//   node scripts/resetar-dados.mjs --executar               # executa
//   node scripts/resetar-dados.mjs --executar --caixa MB=1000,BN=1000,TT=500
//   node scripts/resetar-dados.mjs --executar --incluir-toro
//   node scripts/resetar-dados.mjs --executar --manter-prompts
//   node scripts/resetar-dados.mjs --executar --mesmo-sem-confirmar   # só se o bot estiver comprovadamente parado
//
// SEGURANÇA — a ordem importa e não deve ser mexida:
//   1. TRAVA a operação (global/controle), INVALIDA o estado que o bot guarda em
//      memória (`estado_invalidado_em`) e espera o BOT confirmar pelo heartbeat.
//      Sem a trava, um ciclo em andamento escreveria no meio do reset e
//      recriaria estado que acabou de ser apagado. NÃO confirmou = ABORTA antes
//      de apagar qualquer coisa (ver `decidirSeSegue`): seguir assim mesmo
//      anularia a única proteção do script, e o resíduo que ele existe para
//      evitar entraria justamente pela porta que ele mesmo deixou aberta.
//      Sem a INVALIDAÇÃO, apagar `dados/estado` não alcança a cópia em RAM do
//      orquestrador (ele só lê o Firestore no boot) e o bot segue com o baseline
//      e os contadores de decisão de antes do reset — ver a etapa 1 no código.
//   2. BACKUP em JSON de tudo que vai sumir.
//   3. Apaga em lotes de 500 (limite de batch do Firestore).
//   4. Semeia o caixa virtual e DEIXA TRAVADO — destravar é decisão do dono,
//      depois de conferir a dashboard.
//
// A TORO fica de FORA por padrão: ela é `assistida` e em modo real, então as
// posições dela espelham papéis que o dono tem de verdade na corretora. Apagar
// sem que ele tenha vendido desencontraria o sistema da realidade. Só entra com
// `--incluir-toro`, e mesmo assim a `carteira_manual` é preservada.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- puros (testáveis)

/** Subcoleções de um ativo que o reset esvazia por completo. */
export const SUBCOLECOES_DO_ATIVO = ['historico', 'operacoes', 'posicoes', 'operacoes_manuais'];

/** Docs de `dados/` do ativo que são apagados (recriados pelo próprio ciclo). */
export const DOCS_DO_ATIVO = ['estado', 'estatisticas_simulacao', 'estatisticas_real', 'dashboard'];

/**
 * Campos do `dados/estado` da PLATAFORMA que o reset limpa.
 * `carteira_manual` NÃO está aqui de propósito: é o que o dono tem de verdade
 * na corretora assistida, e o reset não vende nada por ele.
 * `conexao` também fica: descreve a credencial, não a operação.
 */
export const CAMPOS_ESTADO_PLATAFORMA = [
  'carteira_virtual',
  'sincronizacao_saldos_reais',
  'patrimonio_inicio_dia',
];

/** Docs globais e o que fazer com cada um. */
export const GLOBAIS = [
  { id: 'renda_real', acao: 'apagar', porque: 'a régua × CDI recomeça junto com o capital' },
  { id: 'relatorio_decisoes', acao: 'apagar', porque: 'os contadores do delta precisam nascer zerados' },
  { id: 'supervisao', acao: 'apagar_se_reset_de_prompt', porque: 'a camada foi escrita analisando os dados antigos' },
];

/**
 * Traduz `--caixa MB=1000,BN=1000` em { MB: 1000, BN: 1000 }.
 * Valor inválido é ERRO, nunca zero silencioso: semear caixa errado é pior que
 * não semear, porque o robô opera em cima disso.
 */
export function parsearCaixa(texto) {
  if (!texto) return {};
  const out = {};
  for (const par of String(texto).split(',')) {
    const [id, valor] = par.split('=');
    const chave = (id ?? '').trim().toUpperCase();
    const n = Number(valor);
    if (!chave) throw new Error(`--caixa: entrada sem plataforma em "${par}"`);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--caixa: valor inválido para ${chave}: "${valor}"`);
    out[chave] = n;
  }
  return out;
}

/**
 * Monta o plano do reset. PURA: recebe o retrato, devolve o que será feito.
 * Existe separada para o `--executar` e a simulação percorrerem exatamente o
 * mesmo caminho — o que você vê na simulação é o que acontece de verdade.
 */
export function planoDeReset({ plataformas = [], caixa = {}, incluirToro = false, manterPrompts = true } = {}) {
  const alvos = plataformas.filter((p) => (p.assistida === true ? incluirToro : true));
  const ignoradas = plataformas.filter((p) => p.assistida === true && !incluirToro).map((p) => p.id);

  return {
    plataformas: alvos.map((p) => ({
      id: p.id,
      ativos: p.ativos ?? [],
      limparCampos: CAMPOS_ESTADO_PLATAFORMA,
      caixa: Object.prototype.hasOwnProperty.call(caixa, p.id) ? caixa[p.id] : null,
      preservaCarteiraManual: p.assistida === true,
    })),
    ignoradas,
    // O reset SEMPRE desliga o modo vendas (§10.5). O flag mora em
    // `global/controle`, que o reset não apaga — então ele sobreviveria à
    // limpeza e o bot voltaria liquidando uma carteira vazia. Como a liquidação
    // bloqueia COMPRAR, a medição nova simplesmente nunca começaria, e o
    // sintoma ("o robô não compra nada") não aponta para a causa.
    desligaModoVendas: true,
    // O reset SEMPRE invalida o estado que o bot guarda em memória. Apagar os
    // docs `dados/estado` não alcança a cópia em RAM do orquestrador, que só lê
    // o Firestore no boot — sem esta marca o processo continua com o baseline e
    // os contadores de decisão de antes do reset. Ver o comentário na etapa 1.
    invalidaEstadoEmMemoria: true,
    globais: GLOBAIS.filter((g) => g.acao === 'apagar' || !manterPrompts).map((g) => g.id),
    // Caixa pedido para plataforma que não existe é engano de digitação, e
    // engano de digitação em reset custa caro: avisa em vez de ignorar.
    caixaSemPlataforma: Object.keys(caixa).filter((id) => !alvos.some((p) => p.id === id)),
  };
}

/**
 * O reset pode prosseguir depois da espera pela confirmação do bot?
 *
 * PURA de propósito: é a decisão mais perigosa do script e precisa ser testável
 * sem Firestore. A espera (`esperarBotConfirmar`) devolve `false` quando o bot
 * está VIVO e mesmo assim não confirmou a parada — ou seja, pode haver um ciclo
 * escrevendo agora. Apagar nesse estado recria estado no meio da limpeza, que é
 * exatamente o resíduo que motivou o script.
 *
 * A porta de escape existe porque há um caso legítimo: o dono sabe que o
 * processo está parado (pm2 stop) e o heartbeat só não some na hora. Mas ela
 * tem de ser DITA na linha de comando, nunca ser o padrão.
 */
export function decidirSeSegue({ confirmou, forcado = false } = {}) {
  if (confirmou) return { segue: true, motivo: 'bot confirmou a parada' };
  if (forcado) return { segue: true, motivo: 'sem confirmação, mas --mesmo-sem-confirmar foi pedido' };
  return {
    segue: false,
    motivo:
      'o bot NÃO confirmou a parada — nada foi apagado.\n' +
      '   A operação ficou TRAVADA (destrave na dashboard se desistir do reset).\n' +
      '   Confira se o bot está no ar e repita em alguns minutos.\n' +
      '   Se você tem certeza de que o processo está parado: --mesmo-sem-confirmar',
  };
}

// ---------------------------------------------------------------- execução

const arg = (nome) => process.argv.includes(nome);
const valorArg = (nome) => {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : null;
};

async function apagarColecao(db, ref, executar) {
  let total = 0;
  for (;;) {
    const lote = await ref.limit(400).get();
    if (lote.empty) break;
    total += lote.size;
    if (!executar) break; // na simulação basta saber que existe
    const batch = db.batch();
    for (const d of lote.docs) batch.delete(d.ref);
    await batch.commit();
  }
  if (!executar) total = (await ref.count().get()).data().count;
  return total;
}

async function esperarBotConfirmar(db, segundos = 180) {
  const limite = Date.now() + segundos * 1000;
  process.stdout.write('aguardando o bot confirmar a parada');
  while (Date.now() < limite) {
    const s = (await db.collection('global').doc('status_bot').get()).data() ?? {};
    const vivo = s.atualizado_em && Date.now() - Date.parse(s.atualizado_em) < 3 * 60_000;
    if (!vivo) {
      console.log('\n  bot OFFLINE (sem heartbeat há mais de 3 min) — seguindo, não há ciclo para atrapalhar');
      return true;
    }
    if (s.travado === true) {
      console.log('\n  bot confirmou a parada ✅');
      return true;
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('\n  ⚠️  o bot NÃO confirmou a parada em ' + segundos + 's');
  return false;
}

async function principal() {
  const executar = arg('--executar');
  const incluirToro = arg('--incluir-toro');
  const manterPrompts = !arg('--resetar-prompts');
  const caixa = parsearCaixa(valorArg('--caixa'));

  const caminho = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!caminho) throw new Error('defina FIREBASE_SERVICE_ACCOUNT_PATH com o JSON da service account');
  initializeApp({ credential: cert(JSON.parse(readFileSync(caminho, 'utf8'))) });
  const db = getFirestore();

  // Retrato do parque
  const plataformas = [];
  for (const p of (await db.collection('plataformas').get()).docs) {
    const ativos = (await p.ref.collection('ativos').get()).docs.map((a) => a.id);
    plataformas.push({ id: p.id, assistida: p.data().assistida === true, ativos });
  }

  const plano = planoDeReset({ plataformas, caixa, incluirToro, manterPrompts });

  console.log(`\n${executar ? '🔴 EXECUTANDO O RESET' : '🔎 SIMULAÇÃO (nada será escrito)'}\n`);
  for (const p of plano.plataformas) {
    console.log(`${p.id}: ${p.ativos.length} ativo(s) — ${p.ativos.join(', ')}`);
    console.log(`   caixa a semear: ${p.caixa === null ? '(não informado — carteira virtual fica vazia)' : p.caixa}`);
    if (p.preservaCarteiraManual) console.log('   carteira_manual PRESERVADA (papéis reais do dono)');
  }
  if (plano.ignoradas.length) {
    console.log(`\nIGNORADAS (assistidas, use --incluir-toro): ${plano.ignoradas.join(', ')}`);
  }
  if (plano.caixaSemPlataforma.length) {
    throw new Error(`--caixa cita plataforma inexistente ou ignorada: ${plano.caixaSemPlataforma.join(', ')}`);
  }
  console.log(`\nglobais a apagar: ${plano.globais.join(', ')}`);
  console.log(`prompts (regras gerais / do ativo / supervisão): ${manterPrompts ? 'PRESERVADOS' : 'a camada da supervisão será apagada'}`);
  if (plano.desligaModoVendas) {
    const mv = (await db.collection('global').doc('controle').get()).data()?.modo_vendas === true;
    console.log(`modo vendas: ${mv ? 'LIGADO hoje → será DESLIGADO pelo reset' : 'já desligado (nada a fazer)'}`);
  }
  if (plano.invalidaEstadoEmMemoria) {
    console.log('estado em memória do bot: será INVALIDADO (marca em global/controle)');
  }

  if (!executar) {
    console.log('\nNada foi escrito. Para valer: repita com --executar\n');
    return;
  }

  // 1. Trava — antes de qualquer escrita — e, no MESMO ato, desliga a liquidação
  // e invalida o estado que o bot guarda em MEMÓRIA.
  //
  // Modo vendas: a carteira que ele existia para liquidar está prestes a sumir,
  // e `modo_vendas_desde` precisa zerar junto para uma liquidação futura começar
  // no dia 1, com tolerância zero, e não no meio da rampa antiga.
  //
  // `estado_invalidado_em`: o orquestrador lê `dados/estado` de cada ativo UMA
  // vez por boot e depois vive de uma cópia em memória. Apagar os documentos
  // aqui não alcança essa cópia — o processo continua filtrando a variação
  // contra o preço pré-reset e regravando os contadores de decisão antigos nos
  // documentos recém nascidos, contaminando a primeira medição da janela nova.
  // Aconteceu no reset de 2026-07-27, onde 5 ativos voltaram a gravar
  // `decisoes_acumuladas` de 25/07. A marca vai no `global/controle` porque o
  // tick JÁ lê esse doc fresco a cada minuto: custo zero de leitura, e o bot
  // está travado da linha abaixo até o dono destravar, então nada repopula a
  // memória no meio da limpeza.
  await db.collection('global').doc('controle').set(
    {
      operacao_travada: true,
      travado_em: new Date().toISOString(),
      origem: 'script-reset',
      estado_invalidado_em: new Date().toISOString(),
      ...(plano.desligaModoVendas
        ? { modo_vendas: false, modo_vendas_desde: null, modo_vendas_desligado_em: new Date().toISOString() }
        : {}),
    },
    { merge: true },
  );
  console.log('\noperação TRAVADA, modo vendas desligado e estado em memória invalidado');
  const confirmou = await esperarBotConfirmar(db);
  const seguir = decidirSeSegue({ confirmou, forcado: arg('--mesmo-sem-confirmar') });
  if (!seguir.segue) throw new Error(seguir.motivo);
  if (!confirmou) console.log(`  seguindo assim mesmo: ${seguir.motivo}`);

  // 2. Backup do que vai sumir.
  const backup = { em: new Date().toISOString(), plataformas: {}, globais: {} };
  for (const p of plano.plataformas) {
    const dados = { estado: null, ativos: {} };
    dados.estado = (await db.collection('plataformas').doc(p.id).collection('dados').doc('estado').get()).data() ?? null;
    for (const aid of p.ativos) {
      const base = db.collection('plataformas').doc(p.id).collection('ativos').doc(aid);
      const a = { dados: {}, subcolecoes: {} };
      for (const doc of DOCS_DO_ATIVO) a.dados[doc] = (await base.collection('dados').doc(doc).get()).data() ?? null;
      for (const sub of SUBCOLECOES_DO_ATIVO) {
        a.subcolecoes[sub] = (await base.collection(sub).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
      }
      dados.ativos[aid] = a;
    }
    backup.plataformas[p.id] = dados;
  }
  for (const id of plano.globais) backup.globais[id] = (await db.collection('global').doc(id).get()).data() ?? null;

  const arquivo = `backup_reset_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(arquivo, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`backup gravado em ${arquivo}`);

  // 3. Apaga.
  let apagados = 0;
  for (const p of plano.plataformas) {
    for (const aid of p.ativos) {
      const base = db.collection('plataformas').doc(p.id).collection('ativos').doc(aid);
      for (const sub of SUBCOLECOES_DO_ATIVO) {
        const n = await apagarColecao(db, base.collection(sub), true);
        apagados += n;
      }
      for (const doc of DOCS_DO_ATIVO) {
        await base.collection('dados').doc(doc).delete();
        apagados++;
      }
      console.log(`  ${p.id}/${aid} limpo`);
    }
    const est = db.collection('plataformas').doc(p.id).collection('dados').doc('estado');
    const limpeza = {};
    for (const campo of p.limparCampos) limpeza[campo] = FieldValue.delete();
    await est.update(limpeza).catch(() => {});
    // 4. Semeia o caixa virtual (quando informado).
    if (p.caixa !== null) {
      await est.set(
        { carteira_virtual: { saldo_moeda: p.caixa, saldos: {}, inicializada_em: new Date().toISOString() } },
        { merge: true },
      );
      console.log(`  ${p.id}: carteira virtual semeada com ${p.caixa}`);
    }
  }
  for (const id of plano.globais) {
    await db.collection('global').doc(id).delete();
    console.log(`  global/${id} apagado`);
  }

  console.log(`\n✅ reset concluído — ${apagados} documento(s) apagado(s)`);
  console.log('\n⚠️  A OPERAÇÃO CONTINUA TRAVADA de propósito.');
  console.log('   Confira a dashboard (patrimônio, posições, estatísticas) e só então');
  console.log('   clique em "Destravar operação" na Visão geral.\n');
}

// Só roda quando chamado direto — importar (testes) nunca executa nada.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  principal().then(() => process.exit(0)).catch((e) => {
    console.error(`\n❌ ${e.message}\n`);
    process.exit(1);
  });
}
