// firebaseClient.js — ÚNICA camada de acesso à persistência (CLAUDE.md §7).
//
// V2 (V2_Plan.MD §C): os dados vivem na árvore multi-plataforma/multi-ativo
// `plataformas/{P}/...` (detalhada mais abaixo). As coleções planas da V1
// (config/estado/historico/operacoes/posicoes/estatisticas) permanecem no
// banco APENAS como backup e fonte da migração (src/migracao/) — nenhum
// módulo escreve nelas; o acesso a elas é feito pelas funções "brutas".
//
// Backends:
//   - firestore (padrão): Firebase Admin SDK. Credencial via
//     FIREBASE_SERVICE_ACCOUNT_PATH (caminho do JSON da service account) ou
//     GOOGLE_APPLICATION_CREDENTIALS (Application Default Credentials).
//   - memoria: armazenamento em memória com a MESMA interface, para
//     desenvolvimento local e testes sem credenciais (BOT_PERSISTENCIA=memoria).
//     Nunca usar em produção: nada é persistido entre execuções.
//
// Decisões documentadas:
//   - Datas sempre como strings ISO-8601 UTC (consistente com o restante do
//     sistema e legível direto pelo dashboard).
//   - Chaves lidas da persistência são registradas no logger
//     (registrarSegredo) para nunca vazarem em log (regras.md §10).

import { readFileSync } from 'node:fs';
import { log, registrarSegredo, definirSink } from '../utils/logger.js';

/** Estatísticas agregadas iniciais de um ativo/modo (docs `estatisticas_*`). */
export const ESTATISTICAS_PADRAO = {
  lucro_total: 0,
  quantidade_operacoes: 0,
  quantidade_vendas: 0,
  vendas_lucrativas: 0,
  taxa_acerto: null,
  maior_lucro_operacao: null,
  maior_prejuizo_operacao: null,
  atualizado_em: null,
};

// -------------------------------------------------------------------- backends
// Os backends aceitam CAMINHOS de coleção com subcoleções (ex.:
// 'plataformas/MB/ativos/BTC/historico') — no Firestore, caminhos com número
// ímpar de segmentos são coleções válidas; na memória, o caminho é a chave.

let backend = null;

/**
 * Merge profundo com a MESMA semântica do `set(..., { merge: true })` do
 * Firestore: mapas aninhados são mesclados campo a campo; arrays e valores
 * escalares são substituídos por inteiro.
 */
function mesclarProfundo(base, mudancas) {
  const saida = { ...base };
  for (const [chave, valor] of Object.entries(mudancas)) {
    const ehMapa = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    saida[chave] = ehMapa(valor) && ehMapa(base?.[chave]) ? mesclarProfundo(base[chave], valor) : valor;
  }
  return saida;
}

function backendMemoria() {
  const colecoes = new Map();
  const colecao = (nome) => {
    if (!colecoes.has(nome)) colecoes.set(nome, new Map());
    return colecoes.get(nome);
  };
  let contador = 0;
  return {
    tipo: 'memoria',
    async obterDoc(nome, id) {
      const doc = colecao(nome).get(id);
      return doc ? structuredClone(doc) : null;
    },
    async salvarDoc(nome, id, dados) {
      const atual = colecao(nome).get(id) ?? {};
      colecao(nome).set(id, mesclarProfundo(atual, structuredClone(dados)));
    },
    async adicionarDoc(nome, dados, id = null) {
      const docId = id ?? `auto_${String(++contador).padStart(6, '0')}`;
      colecao(nome).set(docId, structuredClone(dados));
      return docId;
    },
    async listarDesde(nome, campo, valorMinimoISO) {
      return [...colecao(nome).values()]
        .filter((d) => typeof d[campo] === 'string' && d[campo] >= valorMinimoISO)
        .sort((a, b) => a[campo].localeCompare(b[campo]))
        .map((d) => structuredClone(d));
    },
    async listarUltimos(nome, campo, quantidade) {
      return [...colecao(nome).values()]
        .filter((d) => typeof d[campo] === 'string')
        .sort((a, b) => b[campo].localeCompare(a[campo]))
        .slice(0, quantidade)
        .map((d) => structuredClone(d));
    },
    async listarPorIgual(nome, campo, valor) {
      return [...colecao(nome).values()]
        .filter((d) => d[campo] === valor)
        .map((d) => structuredClone(d));
    },
    async listarDocs(nome) {
      return [...colecao(nome).entries()].map(([id, dados]) => ({ id, dados: structuredClone(dados) }));
    },
  };
}

async function backendFirestore() {
  // Import dinâmico: o modo memória funciona mesmo sem o firebase-admin.
  const { initializeApp, cert, applicationDefault, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');

  if (getApps().length === 0) {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON; // conteúdo (hospedagem sem arquivos, ex.: Render)
    const caminho = process.env.FIREBASE_SERVICE_ACCOUNT_PATH; // caminho do arquivo (dev local)
    if (json || caminho) {
      const conta = JSON.parse(json ?? readFileSync(caminho, 'utf8'));
      if (conta.private_key) registrarSegredo(conta.private_key);
      initializeApp({ credential: cert(conta) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeApp({ credential: applicationDefault() });
    } else {
      throw new Error(
        'Firebase não configurado: defina FIREBASE_SERVICE_ACCOUNT_PATH (arquivo) ou ' +
          'FIREBASE_SERVICE_ACCOUNT_JSON (conteúdo) — ou BOT_PERSISTENCIA=memoria para desenvolvimento.',
      );
    }
  }

  // ID do banco: o padrão canônico do Firestore é "(default)"; bancos criados
  // com outro nome (ex.: "default") são apontados via FIRESTORE_DATABASE_ID.
  const dbId = process.env.FIRESTORE_DATABASE_ID;
  const db = dbId ? getFirestore(dbId) : getFirestore();
  return {
    tipo: 'firestore',
    async obterDoc(nome, id) {
      const snap = await db.collection(nome).doc(id).get();
      return snap.exists ? snap.data() : null;
    },
    async salvarDoc(nome, id, dados) {
      await db.collection(nome).doc(id).set(dados, { merge: true });
    },
    async adicionarDoc(nome, dados, id = null) {
      if (id) {
        await db.collection(nome).doc(id).set(dados);
        return id;
      }
      const ref = await db.collection(nome).add(dados);
      return ref.id;
    },
    // Filtro por um único campo (índice automático do Firestore); filtros
    // adicionais são aplicados em código por quem chama, para não exigir
    // índices compostos.
    async listarDesde(nome, campo, valorMinimoISO) {
      const snap = await db.collection(nome).where(campo, '>=', valorMinimoISO).get();
      return snap.docs.map((d) => d.data());
    },
    async listarUltimos(nome, campo, quantidade) {
      const snap = await db.collection(nome).orderBy(campo, 'desc').limit(quantidade).get();
      return snap.docs.map((d) => d.data());
    },
    async listarPorIgual(nome, campo, valor) {
      const snap = await db.collection(nome).where(campo, '==', valor).get();
      return snap.docs.map((d) => d.data());
    },
    async listarDocs(nome) {
      const snap = await db.collection(nome).get();
      return snap.docs.map((d) => ({ id: d.id, dados: d.data() }));
    },
  };
}

/**
 * Inicializa a persistência. Chamar uma vez na partida (scheduler.js).
 * modo: 'firestore' (padrão) | 'memoria' — também via env BOT_PERSISTENCIA.
 */
export async function inicializarPersistencia({ modo } = {}) {
  const escolhido = modo ?? process.env.BOT_PERSISTENCIA ?? 'firestore';
  if (escolhido === 'memoria') {
    backend = backendMemoria();
    log.aviso('persistência em MEMÓRIA ativa — apenas para desenvolvimento/testes');
  } else {
    backend = await backendFirestore();
  }
  return backend.tipo;
}

function exigirBackend() {
  if (!backend) {
    throw new Error('persistência não inicializada — chame inicializarPersistencia() antes');
  }
  return backend;
}

// ------------------------------------------------------------------------- logs

/** Grava uma entrada técnica na coleção `logs`. */
export async function gravarLog(entrada) {
  await exigirBackend().adicionarDoc('logs', entrada);
}

/**
 * Conecta o logger do processo à coleção `logs` (melhor esforço: falha de
 * persistência nunca derruba o loop — tratado dentro do logger).
 * Só persiste avisos/erros para não inflar a coleção com info de rotina.
 */
export function conectarLoggerAoFirebase() {
  definirSink(async (entrada) => {
    if (entrada.nivel === 'info') return;
    await gravarLog(entrada);
  });
}

// ============================================================================
// V2 — árvore multi-plataforma/multi-ativo (V2_Plan.MD §C)
//
//   plataformas/{P}                       → doc: config da plataforma
//   plataformas/{P}/dados/api             → credenciais (SÓ o conector lê)
//   plataformas/{P}/dados/template        → prompt padrão da plataforma
//   plataformas/{P}/dados/estado          → carteira virtual + sincronização
//   plataformas/{P}/ativos/{A}            → doc: { manifest, config }
//   plataformas/{P}/ativos/{A}/dados/*    → prompt, contexto, estado,
//                                           estatisticas_simulacao/_real, dashboard
//   plataformas/{P}/ativos/{A}/historico  → subcoleção (verificacao/analise)
//   plataformas/{P}/ativos/{A}/operacoes  → subcoleção (§6.3)
//   plataformas/{P}/ativos/{A}/posicoes   → subcoleção (§11.1)
//
// As funções V1 acima (config/estado/historico/... planos) permanecem apenas
// como LEITURA da estrutura antiga (backup) e fonte da migração — a V2 nunca
// escreve nelas. `logs` continua coleção global (com campos plataforma/ativo).
// ============================================================================

// ------------------------------------------------------------------- padrões V2

/** Config padrão de uma PLATAFORMA (campos do doc `plataformas/{P}`). */
export const PLATAFORMA_PADRAO = {
  nome: '',
  ativa: true,
  tipo: 'exchange_cripto', // 'exchange_cripto' | 'corretora' | ...
  conector: '', // qual conector executa esta plataforma (ex.: 'mb')
  timezone: 'America/Sao_Paulo',
  moeda: 'BRL',
  // A IA é POR PLATAFORMA na V2: cadeia de modelos em ordem de prioridade
  // (do melhor para o pior — filosofia: usar o máximo da quota grátis).
  modelos_ia: ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'],
};

/** Credenciais padrão (doc `plataformas/{P}/dados/api`). */
export const API_PLATAFORMA_PADRAO = {
  api_key_ia: '',
  api_key_id: '',
  api_key_secret: '',
};

/**
 * Manifest padrão de um ATIVO — identidade estrutural (V2_Plan.MD §manifest).
 * O núcleo NUNCA pergunta "é Bitcoin?": ele lê o manifest e se adapta.
 */
export const MANIFEST_PADRAO = {
  id: '',
  nome: '',
  tipo: 'crypto', // 'crypto' | 'acao' | 'fii' | ...
  plataforma: '',
  par: '', // símbolo negociado na plataforma (ex.: 'BTC-BRL')
  mercado24h: true,
  permiteDividendos: false,
  usaContexto: true,
  usaPromptPersonalizado: true,
  usaTemplatePlataforma: true,
  // Camada escrita pelo supervisor semanal (V7.2). Desligar aqui tira ESTE
  // ativo da supervisão sem afetar os demais; o kill-switch geral fica em
  // `global/supervisor.ativo`.
  usaSupervisao: true,
  intervaloPadrao: 15,
  resetPadraoDias: 7,
  versaoPrompt: 1,
  // Resolução dos candles do ciclo de análise (V6.0): cripto/intraday usa o
  // padrão 15m/1h; ativos de swing trade (ex.: B3 no modo assistido) usam
  // '1d'. `candlesContexto` = quantos candles da resolução de contexto somam
  // o "volume_24h" enviado à IA (24 × 1h no padrão; 1 × 1d no diário).
  resolucaoAnalise: '15m',
  resolucaoContexto: '1h',
  candlesContexto: 24,
};

/** Config operacional padrão de um ATIVO (editável pela dashboard). */
export const CONFIG_ATIVO_PADRAO = {
  ativo: true, // ligado/desligado (o orquestrador ignora desligados)
  modo_simulacao: true,
  tempo_entre_analises_minutos: 15,
  percentual_minimo_variacao: 0.3,
  percentual_max_diferenca_execucao: 1.0,
  tempo_reset_dias: 7,
  // Taxas de referência do MERCADO BITCOIN (~0,7% por perna), a única
  // plataforma que cai neste padrão: TT, BN e TORO trazem as suas na semeadura,
  // e ativo cadastrado pela dashboard nasce com a da plataforma dele.
  // Já foi 1,5% "por segurança" — superestimar a taxa não é conservadorismo:
  // infla o breakeven de cada lote e faz o robô segurar posição que já daria
  // lucro (CLAUDE.md §10.4).
  taxa_compra_percentual: 0.7,
  taxa_venda_percentual: 0.7,
  limite_perda_diaria_percentual: 3,
  // Orçamento: percentual máximo do patrimônio da PLATAFORMA que este ativo
  // pode ocupar (V2_Plan.MD §A.3). O percentual da IA aplica sobre o
  // orçamento LIVRE do ativo, nunca sobre o caixa total.
  orcamento_percentual: 100,
  // Distância MÁXIMA entre o preço de compra e o stop-loss que a IA declara
  // (V6.6). Chão mais distante é TRUNCADO neste teto pelo Motor: um stop muito
  // largo equivale a não ter stop, e nenhuma edição de prompt pode desativar a
  // proteção na prática.
  stop_loss_max_distancia_percentual: 15,
  // Distância que o TRAILING AUTOMÁTICO do Motor mantém abaixo do preço
  // enquanto a posição está em lucro (§10.3). A IA pode declarar um valor por
  // posição na compra (`trailing_percentual`, calibrado pela volatilidade);
  // este é o padrão de quem não declarou e das posições anteriores.
  stop_loss_trailing_percentual: 3,
  // Mínimos operacionais POR ATIVO (saíram do código — V2_Plan.MD §B.6).
  // `minimo_ordem_valor` na moeda da plataforma; quantidade na unidade do ativo.
  minimo_ordem_valor: 10,
  minimo_ordem_quantidade: 0.00001,
};

/**
 * Estado de runtime padrão de um ATIVO (doc `.../dados/estado`).
 * ATENÇÃO: `ultima_operacao_executada` fica DE FORA de propósito
 * (V5_2_Plan.MD §3.1) — a automigração do cicloAtivo distingue `undefined`
 * (estado de antes da V5.2, precisa buscar na coleção uma vez) de `null`
 * (já migrado, não há operação); um padrão aqui apagaria essa diferença.
 */
export const ESTADO_ATIVO_PADRAO = {
  preco_ultima_analise: null,
  horario_ultima_analise: null,
  horario_ultima_verificacao: null,
  proxima_analise_em: null,
  ultima_decisao_ia: null,
};

/** Estado padrão de uma PLATAFORMA (doc `plataformas/{P}/dados/estado`). */
export const ESTADO_PLATAFORMA_PADRAO = {
  // Carteira virtual da simulação, POR PLATAFORMA (V2_Plan.MD §B.3):
  // um saldo na moeda da plataforma + um saldo por ativo.
  // { saldo_moeda, saldos: { BTC: 0.01, ... }, inicializada_em }
  carteira_virtual: null,
  // Foto dos saldos reais — referência do detector de depósitos/saques.
  sincronizacao_saldos_reais: null,
  // Referência do circuit breaker POR MODO: patrimônio da plataforma na
  // primeira análise do dia (UTC). { simulacao: { data, valor }, real: {...} }
  patrimonio_inicio_dia: null,
};

/** Documento de texto editável pela dashboard (template/prompt). */
export const DOC_TEXTO_PADRAO = { conteudo: '', versao: 0, atualizado_em: null };

/**
 * Contexto do usuário para a IA (doc `.../dados/contexto`). `validade_ate`
 * (ISO) é definida UMA vez pela própria IA na primeira análise após o contexto
 * ser (re)escrito (V6.2): passada a data, o contexto para de ir para a IA.
 * Ausente/null = ainda sem validade definida (a IA será consultada).
 */
export const CONTEXTO_PADRAO = { texto: '', atualizado_em: null, validade_ate: null, validade_definida_em: null };

// Fallback de chaves para o `.env` local (apenas desenvolvimento) — mapeado
// por plataforma; plataformas futuras adicionam sua entrada aqui.
const ENV_FALLBACK_API = {
  MB: { api_key_ia: 'GEMINI_API_KEY', api_key_id: 'MB_API_TOKEN_ID', api_key_secret: 'MB_API_TOKEN_SECRET' },
  TT: {
    api_key_ia: 'GEMINI_API_KEY',
    tt_client_id: 'TT_CLIENT_ID',
    tt_client_secret: 'TT_CLIENT_SECRET',
    tt_refresh_token: 'TT_REFRESH_TOKEN',
    tt_account_id: 'TT_ACCOUNT_ID',
    tt_ambiente: 'TT_AMBIENTE',
  },
  BN: { api_key_ia: 'GEMINI_API_KEY', bn_api_key: 'BN_API_KEY', bn_api_secret: 'BN_API_SECRET' },
  TORO: { api_key_ia: 'GEMINI_API_KEY', brapi_token: 'BRAPI_TOKEN' },
  // O SteamID64 não é segredo (é público no perfil), mas mora com as
  // credenciais por ser dado de conta — e assim ganha o mesmo fallback local.
  STEAM: { api_key_ia: 'GEMINI_API_KEY', steam_id64: 'STEAM_ID64' },
};

// ------------------------------------------------------------------ caminhos V2

function validarSegmento(valor, nome) {
  if (typeof valor !== 'string' || !valor || valor.includes('/')) {
    throw new Error(`${nome} inválido para caminho de persistência: ${JSON.stringify(valor)}`);
  }
  return valor;
}

const COL_PLATAFORMAS = 'plataformas';
const colDadosPlataforma = (p) => `${COL_PLATAFORMAS}/${validarSegmento(p, 'plataforma')}/dados`;
const colAtivos = (p) => `${COL_PLATAFORMAS}/${validarSegmento(p, 'plataforma')}/ativos`;
const colDadosAtivo = (p, a) => `${colAtivos(p)}/${validarSegmento(a, 'ativo')}/dados`;
const colDoAtivo = (p, a, nome) => `${colAtivos(p)}/${validarSegmento(a, 'ativo')}/${nome}`;

// ------------------------------------------------------------- regras gerais
// Documento GLOBAL (coleção `global`, doc `regras_gerais`): regras simples e
// diretas que valem para TODOS os ativos e plataformas. É a primeira camada
// do prompt final (antes do template da plataforma) e é editável pela
// dashboard. Semente: regras_gerais.md na raiz do repositório.

const COL_GLOBAL = 'global';

/** Regras gerais da IA ({ conteudo, versao, atualizado_em }). */
export async function obterRegrasGerais() {
  const doc = await exigirBackend().obterDoc(COL_GLOBAL, 'regras_gerais');
  return { ...DOC_TEXTO_PADRAO, ...(doc ?? {}) };
}

/** Salva as regras gerais, incrementando a versão (auditoria). */
export async function salvarRegrasGerais(conteudo) {
  const atual = await obterRegrasGerais();
  const doc = { conteudo, versao: (atual.versao ?? 0) + 1, atualizado_em: new Date().toISOString() };
  await exigirBackend().salvarDoc(COL_GLOBAL, 'regras_gerais', doc);
  return doc;
}

// Regras gerais do MODO VENDAS (V8): doc SEPARADO, que substitui o de cima
// enquanto a liquidação estiver ligada. São dois documentos e não um campo
// dentro do mesmo porque o dono precisa poder editar as regras normais sem
// tocar nas de liquidação (e vice-versa) — e porque desligar o modo tem de
// devolver o prompt anterior intacto, sem depender de ninguém ter guardado
// cópia. Semente: .md/regras_gerais_venda.md.

/** Regras gerais do modo vendas ({ conteudo, versao, atualizado_em }). */
export async function obterRegrasGeraisVenda() {
  const doc = await exigirBackend().obterDoc(COL_GLOBAL, 'regras_gerais_venda');
  return { ...DOC_TEXTO_PADRAO, ...(doc ?? {}) };
}

/** Salva as regras gerais do modo vendas, incrementando a versão (auditoria). */
export async function salvarRegrasGeraisVenda(conteudo) {
  const atual = await obterRegrasGeraisVenda();
  const doc = { conteudo, versao: (atual.versao ?? 0) + 1, atualizado_em: new Date().toISOString() };
  await exigirBackend().salvarDoc(COL_GLOBAL, 'regras_gerais_venda', doc);
  return doc;
}

// ------------------------------------------------------------- renda real
// Documento GLOBAL (coleção `global`, doc `renda_real`): total de lucro
// realizado APENAS dos ativos fora da simulação + comparativo com 106% do CDI
// (Selic via API do BCB). Escrito só pelo bot (src/nucleo/rendaReal.js); a
// dashboard apenas exibe.

/** Comparativo de renda real (null se a comparação ainda não começou). */
export async function obterRendaReal() {
  return exigirBackend().obterDoc(COL_GLOBAL, 'renda_real');
}

/** Atualização (merge) do comparativo de renda real. */
export async function salvarRendaReal(parcial) {
  await exigirBackend().salvarDoc(COL_GLOBAL, 'renda_real', parcial);
}

// ---------------------------------------------------- status do bot (heartbeat)
// Documento GLOBAL (coleção `global`, doc `status_bot`): batimento gravado pelo
// orquestrador a cada tick (~1 min) para a dashboard saber que o PROCESSO está
// vivo — na VPS não há mais o monitor externo do Render. Escrito SÓ pelo bot.
// Com uma única instância (topologia A) um doc basta; se um dia voltar a haver
// dois bots escopados, ambos sobrescreveriam este doc — aí seria preciso um doc
// por instância (limitação conhecida, aceitável no cenário atual de bot único).

/** Último heartbeat do bot (null se nunca gravado). */
export async function obterStatusBot() {
  return exigirBackend().obterDoc(COL_GLOBAL, 'status_bot');
}

/** Grava (merge) o heartbeat do bot. */
export async function salvarStatusBot(parcial) {
  await exigirBackend().salvarDoc(COL_GLOBAL, 'status_bot', parcial);
}

// ------------------------------------------------- controle (parada de emergência)
// Documento GLOBAL (coleção `global`, doc `controle`): botão "travar tudo" da
// dashboard (V6.2). Com `operacao_travada: true`, o orquestrador pula a rodada
// inteira (nenhuma análise, nenhuma ordem — real ou simulada); o heartbeat
// segue vivo. Escrito pela DASHBOARD; lido pelo bot a cada tick.
//
// Este doc virou o lugar de TODO flag global que o tick precisa ler fresco:
// `supervisao_solicitada` (V7.2) e `modo_vendas` (V8) pegam carona na leitura
// que já acontece a cada minuto. Um doc próprio para cada um custaria mais
// 1.440 leituras/dia por flag (invariante V5.2).

/** Estado da parada de emergência (null se o botão nunca foi usado). */
export async function obterControle() {
  return exigirBackend().obterDoc(COL_GLOBAL, 'controle');
}

/** Grava (merge) o estado da parada de emergência. */
export async function salvarControle(parcial) {
  await exigirBackend().salvarDoc(COL_GLOBAL, 'controle', parcial);
}

// ----------------------------------------------------------- câmbio (só exibição)
// Documento GLOBAL (coleção `global`, doc `cambio`): cotação USD→BRL (PTAX do
// BCB) usada SÓ para consolidar o patrimônio da visão geral em uma moeda (BRL,
// V6.2). Escrito pelo bot a cada 15 min (src/nucleo/rendaReal.js).

/** Cotações de câmbio para consolidação (null se nunca gravado). */
export async function obterCambio() {
  return exigirBackend().obterDoc(COL_GLOBAL, 'cambio');
}

/** Grava (merge) as cotações de câmbio. */
export async function salvarCambio(parcial) {
  await exigirBackend().salvarDoc(COL_GLOBAL, 'cambio', parcial);
}

// -------------------------------------------------- config do comparativo × CDI
// Documento GLOBAL (coleção `global`, doc `config_renda`): ajustes MANUAIS do
// comparativo de renda × CDI feitos pela dashboard — `selic_manual` (sobrepõe a
// meta Selic da API do BCB quando > 0) e `percentual_cdi` (o multiplicador do
// benchmark, padrão 106%). Escrito pela DASHBOARD; lido pelo bot a cada recálculo.

/** Ajustes manuais do comparativo × CDI (null se nunca configurado). */
export async function obterConfigRenda() {
  return exigirBackend().obterDoc(COL_GLOBAL, 'config_renda');
}

/** Grava (merge) os ajustes manuais do comparativo × CDI. */
export async function salvarConfigRenda(parcial) {
  await exigirBackend().salvarDoc(COL_GLOBAL, 'config_renda', parcial);
}

// ------------------------------------------------ espelho SEM segredo da API
// `plataformas/{P}/dados/api_meta`: só os 4 últimos caracteres de cada chave.
// Existe porque `dados/api` deixou de ser legível pelo navegador (firestore.
// rules, 2026-07-25) — antes a dashboard baixava as credenciais inteiras e
// mascarava na tela, o que protegia nada. Escrito SÓ pelo bot.

/** Mascara um doc de credenciais: cada campo string vira '…1234' (ou null). */
export function mascararApi(api = {}) {
  const meta = {};
  for (const [campo, valor] of Object.entries(api ?? {})) {
    const s = typeof valor === 'string' ? valor.trim() : '';
    meta[campo] = s ? `…${s.slice(-4)}` : null;
  }
  return meta;
}

/** Publica o espelho mascarado das credenciais da plataforma. */
export async function salvarApiMeta(plataformaId, meta) {
  await exigirBackend().salvarDoc(colDadosPlataforma(plataformaId), 'api_meta', {
    campos: meta,
    atualizado_em: new Date().toISOString(),
  });
}

// -------------------------------------------------- relatório de decisões (V7)
// Documento GLOBAL (coleção `global`, doc `relatorio_decisoes`): último
// relatório gerado + o retrato dos contadores de decisão, que é o que permite
// o delta da semana seguinte. Escrito SÓ pelo bot (instância primária).

/** Último relatório de decisões (null se nunca gerado). */
export async function obterRelatorioDecisoes() {
  return exigirBackend().obterDoc(COL_GLOBAL, 'relatorio_decisoes');
}

/** Grava (substitui) o relatório de decisões. */
export async function salvarRelatorioDecisoes(relatorio) {
  await exigirBackend().salvarDoc(COL_GLOBAL, 'relatorio_decisoes', relatorio);
}

// ------------------------------------------------------ supervisor semanal (V7.2)
// TRÊS documentos globais, com donos diferentes de propósito:
//
//   supervisor_prompt — as instruções DO agente supervisor (semente:
//                       .md/supervisor.md). Escrito pela dashboard.
//   supervisor        — config: liga/desliga a camada, cadeia de modelos,
//                       janela. Escrito pela dashboard.
//   supervisao        — a CAMADA que o agente escreve e que entra no prompt do
//                       analista. Escrita pelo BOT toda semana e, quando o dono
//                       quiser, editada por ele na dashboard.
//
// Separar config de conteúdo é o que permite o kill-switch: desligar a camada
// não apaga o que ela dizia, e o dono pode religá-la sem perder o histórico.

/** Quantas versões anteriores da camada ficam guardadas para rollback. */
export const SUPERVISAO_HISTORICO_MAX = 5;

const SUPERVISOR_CONFIG_PADRAO = {
  ativo: true,
  // Cadeia própria: o supervisor roda 1×/semana no início do dia de quota e
  // pode gastar o melhor modelo, sem competir com o analista (que roda o dia
  // inteiro). Sobrescrevível pela dashboard.
  modelos_ia: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-pro'],
  dias_janela: 7,
};

/** Instruções do agente supervisor (doc de texto versionado, como as regras gerais). */
export async function obterPromptSupervisor() {
  const doc = await exigirBackend().obterDoc(COL_GLOBAL, 'supervisor_prompt');
  return { ...DOC_TEXTO_PADRAO, ...(doc ?? {}) };
}

/** Salva as instruções do supervisor, incrementando a versão (auditoria). */
export async function salvarPromptSupervisor(conteudo) {
  const atual = await obterPromptSupervisor();
  const doc = { conteudo, versao: (atual.versao ?? 0) + 1, atualizado_em: new Date().toISOString() };
  await exigirBackend().salvarDoc(COL_GLOBAL, 'supervisor_prompt', doc);
  return doc;
}

/** Configuração do supervisor (padrões do código quando o doc não existe). */
export async function obterConfigSupervisor() {
  const doc = await exigirBackend().obterDoc(COL_GLOBAL, 'supervisor');
  return { ...SUPERVISOR_CONFIG_PADRAO, ...(doc ?? {}) };
}

/** Grava (merge) a configuração do supervisor. */
export async function salvarConfigSupervisor(parcial) {
  await exigirBackend().salvarDoc(COL_GLOBAL, 'supervisor', parcial);
}

/** A camada de supervisão vigente (conteudo vazio = nenhuma camada no prompt). */
export async function obterSupervisao() {
  const doc = await exigirBackend().obterDoc(COL_GLOBAL, 'supervisao');
  return { ...DOC_TEXTO_PADRAO, ...(doc ?? {}) };
}

/**
 * Salva uma versão NOVA da camada, empurrando a anterior para o histórico.
 *
 * O histórico mora no PRÓPRIO doc (lista curta, limitada a
 * SUPERVISAO_HISTORICO_MAX) em vez de numa subcoleção: são poucos KB, o
 * rollback não custa leitura nova e a dashboard já recebe tudo no mesmo
 * onSnapshot que desenha a tela.
 *
 * @param {object} p  conteudo (a camada), diagnostico, mudancas, palpites,
 *                    confianca, modelo, janela, origem ('supervisor' | 'dono')
 */
export async function salvarSupervisao({
  conteudo,
  origem = 'supervisor',
  diagnostico = null,
  mudancas = [],
  palpites = [],
  confianca = null,
  modelo = null,
  janela = null,
  gerado_em = null,
} = {}) {
  const atual = await obterSupervisao();
  const anterior = atual.conteudo
    ? [{ versao: atual.versao ?? 0, conteudo: atual.conteudo, atualizado_em: atual.atualizado_em, diagnostico: atual.diagnostico ?? null }]
    : [];
  // TODOS os campos voláteis são escritos EXPLICITAMENTE (nada de `...meta`):
  // `salvarDoc` faz merge, então um campo omitido manteria o valor da semana
  // passada — a tela mostraria os palpites antigos como se fossem desta rodada.
  // Status atrasado é pior que status ausente: mente com cara de dado fresco.
  const versao = (atual.versao ?? 0) + 1;
  const doc = {
    conteudo,
    origem,
    diagnostico,
    mudancas,
    palpites,
    confianca,
    modelo,
    janela,
    gerado_em,
    versao,
    // QUAL versão esta rodada produziu. O doc mistura duas coisas com ciclos de
    // vida diferentes: a CAMADA em vigor (conteudo/versao/origem) e a RODADA que
    // a gerou (diagnostico/mudancas/palpites/modelo/confianca). Quando o dono
    // edita a camada pela dashboard, só a primeira avança — e sem este campo a
    // tela não teria como saber que o "o que mudou" abaixo descreve um texto que
    // não está mais valendo (aconteceu com a v2 em 2026-07-25).
    versao_rodada: versao,
    atualizado_em: new Date().toISOString(),
    historico: [...anterior, ...(atual.historico ?? [])].slice(0, SUPERVISAO_HISTORICO_MAX),
  };
  await exigirBackend().salvarDoc(COL_GLOBAL, 'supervisao', doc);
  return doc;
}

// ------------------------------------------------------------------- Telegram
// Documento GLOBAL (coleção `global`, doc `telegram`): credenciais do bot de
// AVISOS (V7) e quais eventos notificar. Escrito pela DASHBOARD; lido pelo bot
// via CATÁLOGO cacheado (nenhuma leitura nova no tick de 1 min — V5.2).
// O `bot_token` é segredo: a dashboard o mascara e o logger o redige.

/**
 * Configuração do bot de avisos, já com o token JUNTO (null se não configurado).
 *
 * O token vive em `global/telegram_token`, um doc SEPARADO que as rules tornam
 * ilegível pelo navegador — `global/telegram` guarda só o que não é segredo
 * (chat id, ligado/desligado, eventos) e continua legível para a tela desenhar
 * os controles. Quem chama aqui recebe os dois já mesclados e não precisa saber
 * dessa divisão.
 */
export async function obterTelegram() {
  const [config, segredo] = await Promise.all([
    exigirBackend().obterDoc(COL_GLOBAL, 'telegram'),
    exigirBackend().obterDoc(COL_GLOBAL, 'telegram_token'),
  ]);
  if (!config && !segredo) return null;
  return { ...(config ?? {}), ...(segredo?.bot_token ? { bot_token: segredo.bot_token } : {}) };
}

/** Grava (merge) a configuração NÃO secreta do bot de avisos. */
export async function salvarTelegram(parcial) {
  await exigirBackend().salvarDoc(COL_GLOBAL, 'telegram', parcial);
}

/** Grava o token do bot de avisos no doc que o navegador não consegue ler. */
export async function salvarTelegramToken(bot_token) {
  await exigirBackend().salvarDoc(COL_GLOBAL, 'telegram_token', { bot_token, atualizado_em: new Date().toISOString() });
}

/**
 * Migração única: token que ficou no doc LEGÍVEL (antes das rules de
 * 2026-07-25) é movido para o doc secreto e zerado na origem. Sem isto, o
 * segredo continuaria ao alcance do navegador para sempre.
 */
export async function migrarTokenTelegram() {
  const config = await exigirBackend().obterDoc(COL_GLOBAL, 'telegram');
  const token = typeof config?.bot_token === 'string' ? config.bot_token.trim() : '';
  if (!token) return { migrado: false };
  await salvarTelegramToken(token);
  // `token_configurado` é o sinalizador NÃO secreto que a tela usa no lugar do
  // token: sem ele a dashboard acharia que nada está configurado.
  await exigirBackend().salvarDoc(COL_GLOBAL, 'telegram', { bot_token: null, token_configurado: true });
  return { migrado: true };
}

// ---------------------------------------------------------------- plataformas V2

/** Todas as plataformas cadastradas: [{ id, ...config }]. */
export async function listarPlataformas() {
  const docs = await exigirBackend().listarDocs(COL_PLATAFORMAS);
  return docs.map(({ id, dados }) => ({ ...PLATAFORMA_PADRAO, ...dados, id }));
}

/** Config de uma plataforma, mesclada com o padrão (null se não existe). */
export async function obterPlataforma(plataformaId) {
  const doc = await exigirBackend().obterDoc(COL_PLATAFORMAS, plataformaId);
  return doc ? { ...PLATAFORMA_PADRAO, ...doc, id: plataformaId } : null;
}

/** Atualização parcial da config de uma plataforma. */
export async function salvarPlataforma(plataformaId, parcial) {
  await exigirBackend().salvarDoc(COL_PLATAFORMAS, validarSegmento(plataformaId, 'plataforma'), parcial);
}

/**
 * Credenciais da plataforma (doc `dados/api`). Chaves vazias caem para o
 * `.env` local (apenas desenvolvimento). Toda chave lida é registrada no
 * logger como segredo — nunca aparece em log.
 */
export async function obterApiPlataforma(plataformaId) {
  const doc = await exigirBackend().obterDoc(colDadosPlataforma(plataformaId), 'api');
  const api = { ...API_PLATAFORMA_PADRAO, ...(doc ?? {}) };
  const fallback = ENV_FALLBACK_API[plataformaId] ?? {};
  for (const [campo, variavel] of Object.entries(fallback)) {
    api[campo] ||= process.env[variavel] ?? '';
  }
  for (const valor of Object.values(api)) {
    if (typeof valor === 'string' && valor) registrarSegredo(valor);
  }
  return api;
}

/** Atualização parcial das credenciais da plataforma. */
export async function salvarApiPlataforma(plataformaId, parcial) {
  await exigirBackend().salvarDoc(colDadosPlataforma(plataformaId), 'api', parcial);
}

/** Template (prompt padrão) da plataforma. */
export async function obterTemplatePlataforma(plataformaId) {
  const doc = await exigirBackend().obterDoc(colDadosPlataforma(plataformaId), 'template');
  return { ...DOC_TEXTO_PADRAO, ...(doc ?? {}) };
}

/** Salva o template, incrementando a versão (auditoria — V2_Plan.MD §B.8). */
export async function salvarTemplatePlataforma(plataformaId, conteudo) {
  const atual = await obterTemplatePlataforma(plataformaId);
  const doc = { conteudo, versao: (atual.versao ?? 0) + 1, atualizado_em: new Date().toISOString() };
  await exigirBackend().salvarDoc(colDadosPlataforma(plataformaId), 'template', doc);
  return doc;
}

/** Estado de runtime da plataforma (carteira virtual + sincronização). */
export async function obterEstadoPlataforma(plataformaId) {
  const doc = await exigirBackend().obterDoc(colDadosPlataforma(plataformaId), 'estado');
  return { ...structuredClone(ESTADO_PLATAFORMA_PADRAO), ...(doc ?? {}) };
}

/** Atualização parcial do estado da plataforma. */
export async function salvarEstadoPlataforma(plataformaId, parcial) {
  await exigirBackend().salvarDoc(colDadosPlataforma(plataformaId), 'estado', parcial);
}

/**
 * Retrato do INVENTÁRIO da plataforma (doc `plataformas/{P}/dados/inventario`).
 * Usado pelo modo assistido da Steam: o bot lê o inventário público do dono,
 * grava a lista aqui e a dashboard só desenha — os endpoints da Steam não
 * liberam CORS, então uma chamada direta do navegador falharia.
 * Um documento só (não uma subcoleção): a tela o lê por inteiro, sempre.
 */
export const INVENTARIO_PADRAO = { itens: [], atualizado_em: null, erro: null };

export async function obterInventarioPlataforma(plataformaId) {
  const doc = await exigirBackend().obterDoc(colDadosPlataforma(plataformaId), 'inventario');
  return { ...structuredClone(INVENTARIO_PADRAO), ...(doc ?? {}) };
}

/**
 * Grava o retrato inteiro. `salvarDoc` mescla por CAMPO, mas um array é
 * substituído por completo nos dois backends — e é disso que dependemos aqui:
 * item que o dono vendeu precisa DESAPARECER da tela, não virar fantasma
 * (mesma lição do "status atrasado é pior que status ausente", V7.0).
 * Por isso os itens vivem num array só, nunca num mapa por id.
 */
export async function salvarInventarioPlataforma(plataformaId, { itens, erro = null }) {
  const doc = {
    itens: Array.isArray(itens) ? itens : [],
    atualizado_em: new Date().toISOString(),
    erro,
  };
  await exigirBackend().salvarDoc(colDadosPlataforma(plataformaId), 'inventario', doc);
  return doc;
}

/**
 * Notícias do JOGO da plataforma (doc `plataformas/{P}/dados/noticias`) —
 * fase 2 da Steam. Guarda os anúncios oficiais já limpos, mais a lista de
 * `gids` que o bot já viu: é ela, e não a data, que responde "isto é novo?"
 * (a Valve edita notas antigas, e o título é sempre o mesmo).
 */
export const NOTICIAS_PADRAO = { itens: [], gids_vistos: [], atualizado_em: null, ultima_novidade_em: null };

export async function obterNoticiasPlataforma(plataformaId) {
  const doc = await exigirBackend().obterDoc(colDadosPlataforma(plataformaId), 'noticias');
  return { ...structuredClone(NOTICIAS_PADRAO), ...(doc ?? {}) };
}

/** Grava o retrato inteiro (arrays são substituídos — ver `salvarInventarioPlataforma`). */
export async function salvarNoticiasPlataforma(plataformaId, { itens, gids_vistos, ultima_novidade_em = null }) {
  const doc = {
    itens: Array.isArray(itens) ? itens : [],
    gids_vistos: Array.isArray(gids_vistos) ? gids_vistos : [],
    atualizado_em: new Date().toISOString(),
    ultima_novidade_em,
  };
  await exigirBackend().salvarDoc(colDadosPlataforma(plataformaId), 'noticias', doc);
  return doc;
}

/**
 * Alertas de preço-alvo por item (doc `plataformas/{P}/dados/alertas`).
 *
 * DOIS donos, em campos separados de propósito: `itens` é escrito pela
 * DASHBOARD (os alvos que o dono definiu) e `estado` pelo BOT (o "já avisei
 * desta travessia"). Como o merge do Firestore é por campo, um nunca apaga o
 * outro — e o estado precisa estar no banco, não em memória, senão cada deploy
 * reenviaria os alertas já dados.
 */
export const ALERTAS_PADRAO = { itens: {}, estado: {}, atualizado_em: null };

export async function obterAlertasPlataforma(plataformaId) {
  const doc = await exigirBackend().obterDoc(colDadosPlataforma(plataformaId), 'alertas');
  return { ...structuredClone(ALERTAS_PADRAO), ...(doc ?? {}) };
}

/** Só o BOT chama: grava o estado das travessias já avisadas. */
export async function salvarEstadoAlertas(plataformaId, estado) {
  await exigirBackend().salvarDoc(colDadosPlataforma(plataformaId), 'alertas', {
    estado: estado ?? {},
    atualizado_em: new Date().toISOString(),
  });
}

// --------------------------------------------------------------------- ativos V2

/** Todos os ativos da plataforma: [{ id, manifest, config }]. */
export async function listarAtivos(plataformaId) {
  const docs = await exigirBackend().listarDocs(colAtivos(plataformaId));
  return docs.map(({ id, dados }) => ({
    id,
    manifest: { ...MANIFEST_PADRAO, ...(dados.manifest ?? {}) },
    config: { ...CONFIG_ATIVO_PADRAO, ...(dados.config ?? {}) },
  }));
}

/** Um ativo: { id, manifest, config } mesclados com os padrões (null se não existe). */
export async function obterAtivo(plataformaId, ativoId) {
  const doc = await exigirBackend().obterDoc(colAtivos(plataformaId), ativoId);
  if (!doc) return null;
  return {
    id: ativoId,
    manifest: { ...MANIFEST_PADRAO, ...(doc.manifest ?? {}) },
    config: { ...CONFIG_ATIVO_PADRAO, ...(doc.config ?? {}) },
  };
}

/**
 * Atualização parcial de um ativo. `parcial` pode conter `manifest` e/ou
 * `config` — mapas aninhados são mesclados campo a campo (merge profundo).
 */
export async function salvarAtivo(plataformaId, ativoId, parcial) {
  await exigirBackend().salvarDoc(colAtivos(plataformaId), validarSegmento(ativoId, 'ativo'), parcial);
}

/** Prompt específico do ativo. */
export async function obterPromptAtivo(plataformaId, ativoId) {
  const doc = await exigirBackend().obterDoc(colDadosAtivo(plataformaId, ativoId), 'prompt');
  return { ...DOC_TEXTO_PADRAO, ...(doc ?? {}) };
}

/** Salva o prompt do ativo, incrementando a versão. */
export async function salvarPromptAtivo(plataformaId, ativoId, conteudo) {
  const atual = await obterPromptAtivo(plataformaId, ativoId);
  const doc = { conteudo, versao: (atual.versao ?? 0) + 1, atualizado_em: new Date().toISOString() };
  await exigirBackend().salvarDoc(colDadosAtivo(plataformaId, ativoId), 'prompt', doc);
  return doc;
}

/** Contexto do usuário para o ativo (notícias, opiniões, macro…). */
export async function obterContextoAtivo(plataformaId, ativoId) {
  const doc = await exigirBackend().obterDoc(colDadosAtivo(plataformaId, ativoId), 'contexto');
  return { ...CONTEXTO_PADRAO, ...(doc ?? {}) };
}

/**
 * Salva o contexto do ativo (a data de atualização É enviada à IA — §B.7).
 * Reescrever o texto ZERA a validade (V6.2): o contexto novo volta a ser
 * consultado pela IA na próxima análise. A dashboard escreve direto no doc
 * (setDoc sem merge) — o mesmo efeito.
 */
export async function salvarContextoAtivo(plataformaId, ativoId, texto) {
  const doc = { texto, atualizado_em: new Date().toISOString(), validade_ate: null, validade_definida_em: null };
  await exigirBackend().salvarDoc(colDadosAtivo(plataformaId, ativoId), 'contexto', doc);
  return doc;
}

/**
 * Grava a validade do contexto DEFINIDA PELA IA (V6.2) — merge parcial, não
 * toca no texto. Só o bot chama (cicloAtivo), uma vez por vida do contexto;
 * quem chama deve invalidar o catálogo depois (o contexto é cacheado).
 */
export async function salvarValidadeContexto(plataformaId, ativoId, { validade_ate, validade_definida_em }) {
  await exigirBackend().salvarDoc(colDadosAtivo(plataformaId, ativoId), 'contexto', {
    validade_ate,
    validade_definida_em,
  });
}

/** Estado de runtime do ativo (baseline do filtro, última decisão…). */
export async function obterEstadoAtivo(plataformaId, ativoId) {
  const doc = await exigirBackend().obterDoc(colDadosAtivo(plataformaId, ativoId), 'estado');
  return { ...structuredClone(ESTADO_ATIVO_PADRAO), ...(doc ?? {}) };
}

/** Atualização parcial do estado do ativo. */
export async function salvarEstadoAtivo(plataformaId, ativoId, parcial) {
  await exigirBackend().salvarDoc(colDadosAtivo(plataformaId, ativoId), 'estado', parcial);
}

/** Estatísticas agregadas do ativo POR MODO ('simulacao' | 'real'). */
/**
 * Série de preço construída pelo PRÓPRIO bot (doc
 * `plataformas/{P}/ativos/{A}/dados/serie_preco`), para mercados sem candle —
 * hoje as skins da Steam. Um ponto é { t, p }: instante e preço, sem OHLC,
 * porque inventar máxima/mínima a partir de amostras horárias seria fabricar
 * precisão que não existe.
 */
export const SERIE_PRECO_PADRAO = { pontos: [], atualizado_em: null };

export async function obterSeriePrecoAtivo(plataformaId, ativoId) {
  const doc = await exigirBackend().obterDoc(colDadosAtivo(plataformaId, ativoId), 'serie_preco');
  return { ...structuredClone(SERIE_PRECO_PADRAO), ...(doc ?? {}) };
}

export async function salvarSeriePrecoAtivo(plataformaId, ativoId, pontos) {
  const doc = { pontos: Array.isArray(pontos) ? pontos : [], atualizado_em: new Date().toISOString() };
  await exigirBackend().salvarDoc(colDadosAtivo(plataformaId, ativoId), 'serie_preco', doc);
  return doc;
}

export async function obterEstatisticasAtivo(plataformaId, ativoId, modo = 'simulacao') {
  const doc = await exigirBackend().obterDoc(colDadosAtivo(plataformaId, ativoId), `estatisticas_${modo}`);
  return { ...ESTATISTICAS_PADRAO, ...(doc ?? {}) };
}

/** Atualização parcial das estatísticas do ativo no modo. */
export async function salvarEstatisticasAtivo(plataformaId, ativoId, modo, parcial) {
  await exigirBackend().salvarDoc(colDadosAtivo(plataformaId, ativoId), `estatisticas_${modo}`, {
    ...parcial,
    atualizado_em: new Date().toISOString(),
  });
}

/** Agregados de APRESENTAÇÃO do ativo (doc `dados/dashboard`) — sem lógica de negócio. */
export async function obterDashboardAtivo(plataformaId, ativoId) {
  return (await exigirBackend().obterDoc(colDadosAtivo(plataformaId, ativoId), 'dashboard')) ?? {};
}

/** Atualização parcial dos agregados de apresentação do ativo. */
export async function salvarDashboardAtivo(plataformaId, ativoId, parcial) {
  await exigirBackend().salvarDoc(colDadosAtivo(plataformaId, ativoId), 'dashboard', parcial);
}

// ------------------------------------------- histórico/operações/posições V2

/** Registra uma entrada no histórico do ativo (verificacao/analise). */
export async function registrarAnaliseAtivo(plataformaId, ativoId, entrada) {
  const doc = { horario: new Date().toISOString(), ...entrada };
  await exigirBackend().adicionarDoc(colDoAtivo(plataformaId, ativoId, 'historico'), doc);
  return doc;
}

/** Últimas N entradas do histórico do ativo (mais recentes primeiro). */
export async function obterHistoricoRecenteAtivo(plataformaId, ativoId, quantidade = 20) {
  return exigirBackend().listarUltimos(colDoAtivo(plataformaId, ativoId, 'historico'), 'horario', quantidade);
}

/** Registra uma operação do ativo (formato §6.3), usando `op.id` como id do doc. */
export async function registrarOperacaoAtivo(plataformaId, ativoId, op) {
  if (!op?.id) throw new Error('registrarOperacaoAtivo: operação sem id');
  await exigirBackend().adicionarDoc(colDoAtivo(plataformaId, ativoId, 'operacoes'), op, op.id);
  return op;
}

/** Operações EXECUTADAS do ativo desde a data ISO (regra de reset). */
export async function obterOperacoesExecutadasDesdeAtivo(plataformaId, ativoId, dataISO) {
  const todas = await exigirBackend().listarDesde(colDoAtivo(plataformaId, ativoId, 'operacoes'), 'horario', dataISO);
  return todas.filter((op) => op.status === 'executada');
}

/**
 * TODAS as operações do ativo desde a data ISO, em qualquer status — inclui
 * rejeições, recomendações e erros. Usada pelo relatório de decisões, que
 * precisa contar o que NÃO virou execução tanto quanto o que virou.
 */
export async function obterOperacoesDesdeAtivo(plataformaId, ativoId, dataISO) {
  return exigirBackend().listarDesde(colDoAtivo(plataformaId, ativoId, 'operacoes'), 'horario', dataISO);
}

/** Uma posição específica pelo id (null se não existir). */
export async function obterPosicaoAtivo(plataformaId, ativoId, id) {
  return exigirBackend().obterDoc(colDoAtivo(plataformaId, ativoId, 'posicoes'), id);
}

/** Última operação executada do ativo (ou null). Busca nas 50 mais recentes. */
export async function obterUltimaOperacaoExecutadaAtivo(plataformaId, ativoId) {
  const recentes = await exigirBackend().listarUltimos(colDoAtivo(plataformaId, ativoId, 'operacoes'), 'horario', 50);
  return recentes.find((op) => op.status === 'executada') ?? null;
}

/** Registra uma posição do ativo (usa `pos.id` como id do documento). */
export async function registrarPosicaoAtivo(plataformaId, ativoId, pos) {
  if (!pos?.id) throw new Error('registrarPosicaoAtivo: posição sem id');
  await exigirBackend().adicionarDoc(colDoAtivo(plataformaId, ativoId, 'posicoes'), pos, pos.id);
  return pos;
}

/** Atualização parcial de uma posição do ativo. */
export async function atualizarPosicaoAtivo(plataformaId, ativoId, id, parcial) {
  await exigirBackend().salvarDoc(colDoAtivo(plataformaId, ativoId, 'posicoes'), id, parcial);
}

/**
 * Todas as posições do ativo em um modo ('simulacao' | 'real'), INCLUSIVE as
 * fechadas — a coleção inteira. Uso pontual (testes/migração/auditoria);
 * o caminho quente usa obterPosicoesAbertasAtivo (V5_2_Plan.MD §4.1).
 */
export async function obterPosicoesAtivoPorModo(plataformaId, ativoId, modo) {
  return exigirBackend().listarPorIgual(colDoAtivo(plataformaId, ativoId, 'posicoes'), 'modo', modo);
}

/**
 * Só as posições NÃO FECHADAS do ativo no modo, pela query de campo único
 * `aberta_modo` ('simulacao' | 'real' enquanto aberta; null ao fechar) —
 * posições fechadas nunca mais são lidas pelo ciclo (V5_2_Plan.MD §4.1).
 * Pressupõe o backfill da inicialização (posições antigas sem o campo).
 */
export async function obterPosicoesAbertasAtivo(plataformaId, ativoId, modo) {
  return exigirBackend().listarPorIgual(colDoAtivo(plataformaId, ativoId, 'posicoes'), 'aberta_modo', modo);
}

// ------------------------------------- operações manuais (modo assistido V6.0)
// Fila `plataformas/{P}/ativos/{A}/operacoes_manuais`: a DASHBOARD adiciona o
// que o dono executou na corretora (plataformas sem API, ex.: Toro) e o BOT
// drena no início de cada ciclo (src/nucleo/operacoesManuais.js), aplicando em
// posições/caixa/estatísticas e marcando `processada: true`. Docs processados
// permanecem como trilha de auditoria — nunca são apagados pelo bot.

/**
 * Registra um pedido de operação manual (dashboard/testes). O id do documento
 * também vai NUM CAMPO `id` — a query de pendentes é por igualdade
 * (`processada == false`, sem ler a coleção inteira — invariante V5.2) e o
 * campo permite marcar o processamento sem depender do id do snapshot.
 */
export async function registrarOperacaoManualAtivo(plataformaId, ativoId, pedido) {
  const id = pedido.id ?? `opman_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const doc = { processada: false, criada_em: new Date().toISOString(), ...pedido, id };
  await exigirBackend().adicionarDoc(colDoAtivo(plataformaId, ativoId, 'operacoes_manuais'), doc, id);
  return doc;
}

/** Pedidos de operação manual ainda não processados pelo bot (query por igualdade). */
export async function obterOperacoesManuaisPendentes(plataformaId, ativoId) {
  return exigirBackend().listarPorIgual(
    colDoAtivo(plataformaId, ativoId, 'operacoes_manuais'),
    'processada',
    false,
  );
}

/** Atualização parcial de um pedido manual (marcação de processado/erro). */
export async function atualizarOperacaoManualAtivo(plataformaId, ativoId, id, parcial) {
  await exigirBackend().salvarDoc(colDoAtivo(plataformaId, ativoId, 'operacoes_manuais'), id, parcial);
}

// NOTA: as funções do doc `dados/dividendos` (dedupe + throttle da consulta
// AUTOMÁTICA de proventos) foram removidas na revisão de 2026-07-26. A consulta
// automática foi desligada na V6.3 — o plano gratuito da brapi não entrega
// proventos —, e desde então o dono informa o valor por ação pela dashboard
// (fila `operacoes_manuais`, tipo DIVIDENDO). Ficaram dois acessores que nada
// chamava. Se a consulta automática voltar, voltam com ela.

// -------------------------------------------------- acesso bruto (migração V2)
// Usado SOMENTE por src/migracao/migrarV1paraV2.js para ler as coleções V1 e
// copiar documentos preservando ids. Nenhum outro módulo deve usar.

export async function lerDocBruto(caminhoColecao, id) {
  return exigirBackend().obterDoc(caminhoColecao, id);
}

export async function salvarDocBruto(caminhoColecao, id, dados) {
  await exigirBackend().salvarDoc(caminhoColecao, id, dados);
}

export async function adicionarDocBruto(caminhoColecao, dados, id = null) {
  return exigirBackend().adicionarDoc(caminhoColecao, dados, id);
}

export async function listarColecaoBruta(caminhoColecao) {
  return exigirBackend().listarDocs(caminhoColecao);
}
