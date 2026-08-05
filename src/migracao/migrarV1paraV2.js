// migrarV1paraV2.js — migração ÚNICA e IDEMPOTENTE da estrutura V1 (coleções
// planas: config/estado/historico/operacoes/posicoes/estatisticas) para a
// árvore V2 `plataformas/MB/ativos/BTC/...` (V2_Plan.MD §E).
//
// Regras:
//   - Idempotente e RETOMÁVEL: a conclusão é marcada pelo campo
//     `migracao_concluida_em` no doc da plataforma, gravado APENAS NO FIM.
//     Se o processo cair no meio das cópias, a próxima inicialização retoma
//     só o que falta (dedupe por id nas operações/posições e por `horario`
//     no histórico) — nunca duplica, nunca fica parcial para sempre.
//   - As coleções V1 ficam INTOCADAS como backup — nunca apagadas.
//   - Instalação nova (sem dados V1): semeia a árvore V2 com os padrões.
//   - Renomeação de campo: `quantidade_btc` → `quantidade` (o núcleo V2 é
//     agnóstico de ativo — nada de "btc" em nome de campo genérico).
//   - O conteúdo de src/ia/promptBase.md vira o TEMPLATE da plataforma MB no
//     Firestore (fonte única editável pela dashboard); o arquivo permanece no
//     repo apenas como semente.

import { readFileSync } from 'node:fs';
import {
  obterPlataforma,
  listarPlataformas,
  listarAtivos,
  obterRegrasGerais,
  salvarRegrasGerais,
  obterRegrasGeraisVenda,
  salvarRegrasGeraisVenda,
  obterPromptSupervisor,
  salvarPromptSupervisor,
  salvarPlataforma,
  salvarApiPlataforma,
  salvarTemplatePlataforma,
  salvarEstadoPlataforma,
  salvarAtivo,
  salvarEstadoAtivo,
  salvarEstatisticasAtivo,
  lerDocBruto,
  salvarDocBruto,
  listarColecaoBruta,
  adicionarDocBruto,
  CONFIG_ATIVO_PADRAO,
  MANIFEST_PADRAO,
} from '../firebase/firebaseClient.js';
import { log } from '../utils/logger.js';

const PLATAFORMA = 'MB';
const ATIVO_V1 = 'BTC';

/** Seeds dos ativos da plataforma MB na V2 (V2_Plan.MD §A.1). */
export const SEEDS_ATIVOS_MB = [
  {
    id: 'BTC',
    manifest: { id: 'BTC', nome: 'Bitcoin', tipo: 'crypto', plataforma: PLATAFORMA, par: 'BTC-BRL' },
    // BTC herda a config da V1 na migração; estes valores valem só em
    // instalação nova.
    config: { ativo: true, orcamento_percentual: 100, minimo_ordem_quantidade: 0.00001 },
  },
  {
    id: 'ETH',
    manifest: { id: 'ETH', nome: 'Ethereum', tipo: 'crypto', plataforma: PLATAFORMA, par: 'ETH-BRL' },
    // Nasce DESLIGADO e com orçamento 0: o usuário define o orçamento na
    // dashboard antes de ligar (evita disputa acidental pelo caixa do BTC).
    config: { ativo: false, orcamento_percentual: 0, minimo_ordem_quantidade: 0.0001 },
  },
  {
    id: 'SOL',
    manifest: { id: 'SOL', nome: 'Solana', tipo: 'crypto', plataforma: PLATAFORMA, par: 'SOL-BRL' },
    config: { ativo: false, orcamento_percentual: 0, minimo_ordem_quantidade: 0.001 },
  },
];

// O núcleo V2 é agnóstico de ativo/moeda: campos com "btc"/"brl"/"mb" no nome
// viram os genéricos correspondentes ao serem copiados.
const RENOMEACOES = {
  quantidade_btc: 'quantidade',
  valor_brl: 'valor',
  taxa_mb: 'taxa',
  taxa_compra_brl: 'taxa_compra',
  taxa_venda_brl: 'taxa_venda',
  patrimonio_brl: 'patrimonio',
  lucro_total_brl: 'lucro_total',
  patrimonio_inicial_brl: 'patrimonio_inicial',
};

/** Aplica as renomeações (raso + snapshots de posições aninhados). */
function converterCampos(doc) {
  const saida = {};
  for (const [chave, valor] of Object.entries(doc)) {
    saida[RENOMEACOES[chave] ?? chave] = valor;
  }
  if (Array.isArray(saida.posicoes)) {
    saida.posicoes = saida.posicoes.map((p) =>
      p && typeof p === 'object' && !Array.isArray(p) ? converterCampos(p) : p,
    );
  }
  return saida;
}

/**
 * Copia os docs de uma coleção V1 para uma subcoleção V2, PULANDO o que já
 * existe no destino (retomada segura): por id quando `preservarId`, ou pela
 * chave de dedupe (ex.: `horario`) quando os ids do destino são automáticos.
 */
async function copiarColecao(origem, destino, { preservarId, chaveDedupe = null }) {
  const existentes = await listarColecaoBruta(destino);
  const idsExistentes = new Set(existentes.map((d) => d.id));
  const chavesExistentes = chaveDedupe
    ? new Set(existentes.map((d) => d.dados?.[chaveDedupe]).filter(Boolean))
    : null;

  let copiados = 0;
  for (const { id, dados } of await listarColecaoBruta(origem)) {
    if (preservarId && idsExistentes.has(id)) continue;
    if (chavesExistentes && dados?.[chaveDedupe] && chavesExistentes.has(dados[chaveDedupe])) continue;
    await adicionarDocBruto(destino, converterCampos(dados), preservarId ? id : null);
    copiados += 1;
  }
  return copiados;
}

/** Cópia das três coleções históricas (compartilhada entre migração e retomada). */
async function copiarColecoesHistoricas() {
  const base = `plataformas/${PLATAFORMA}/ativos/${ATIVO_V1}`;
  return {
    historico: await copiarColecao('historico', `${base}/historico`, { preservarId: false, chaveDedupe: 'horario' }),
    operacoes: await copiarColecao('operacoes', `${base}/operacoes`, { preservarId: true }),
    posicoes: await copiarColecao('posicoes', `${base}/posicoes`, { preservarId: true }),
  };
}

/**
 * Garante que o doc GLOBAL de regras gerais existe (semente:
 * .md/regras_gerais.md no repositório). Roda em toda inicialização —
 * só grava quando o documento ainda não existe (nunca sobrescreve edições
 * feitas pela dashboard). Idempotente e independente da migração V1→V2.
 */
export async function garantirRegrasGerais() {
  const atual = await obterRegrasGerais();
  if (atual.versao > 0 || atual.conteudo) return { semeado: false };
  const semente = readFileSync(new URL('../../.md/regras_gerais.md', import.meta.url), 'utf8');
  const doc = await salvarRegrasGerais(semente);
  log.info('regras gerais da IA semeadas a partir de regras_gerais.md', { versao: doc.versao });
  return { semeado: true };
}

/**
 * Garante que o doc GLOBAL de regras gerais do MODO VENDAS existe (semente:
 * .md/regras_gerais_venda.md). Mesmo padrão de `garantirRegrasGerais`: só grava
 * quando o documento ainda não existe, para uma edição feita na dashboard nunca
 * ser desfeita por um deploy.
 *
 * Semeado SEMPRE, mesmo com o modo desligado: o dono precisa poder ler e ajustar
 * o texto ANTES de ligar a liquidação — descobrir que o prompt não era o
 * esperado com o modo já rodando seria a pior hora possível.
 */
export async function garantirRegrasGeraisVenda() {
  const atual = await obterRegrasGeraisVenda();
  if (atual.versao > 0 || atual.conteudo) return { semeado: false };
  const semente = readFileSync(new URL('../../.md/regras_gerais_venda.md', import.meta.url), 'utf8');
  const doc = await salvarRegrasGeraisVenda(semente);
  log.info('regras gerais do MODO VENDAS semeadas a partir de regras_gerais_venda.md', { versao: doc.versao });
  return { semeado: true };
}

/**
 * Garante que o doc GLOBAL com as instruções do SUPERVISOR semanal existe
 * (semente: .md/supervisor.md). Mesmo padrão de `garantirRegrasGerais`: só
 * grava quando o documento ainda não existe — edições feitas na dashboard
 * nunca são sobrescritas por um deploy.
 */
export async function garantirPromptSupervisor() {
  const atual = await obterPromptSupervisor();
  if (atual.versao > 0 || atual.conteudo) return { semeado: false };
  const semente = readFileSync(new URL('../../.md/supervisor.md', import.meta.url), 'utf8');
  const doc = await salvarPromptSupervisor(semente);
  log.info('instruções do supervisor semanal semeadas a partir de supervisor.md', { versao: doc.versao });
  return { semeado: true };
}

/**
 * Garante que a plataforma TASTYTRADE existe na árvore V2 (semeadura única,
 * como garantirRegrasGerais). Nasce SEM ativos — o cadastro é feito pela
 * dashboard (tela da plataforma) — e sem credenciais: o dono preenche
 * client secret/refresh token (OAuth2) na dashboard antes de operar.
 * Nunca sobrescreve uma plataforma TT já existente (edições preservadas).
 */
export async function garantirPlataformaTT() {
  const existente = await obterPlataforma('TT');
  if (existente) return { semeado: false };

  const agora = new Date().toISOString();
  await salvarPlataforma('TT', {
    nome: 'Tastytrade',
    ativa: true,
    tipo: 'corretora',
    conector: 'tt',
    timezone: 'America/New_York',
    moeda: 'USD',
    // Janela heurística de FALLBACK do pregão (NYSE/Nasdaq) — o estado real
    // (com feriados e meio-pregão) vem do conector via estadoMercado().
    pregao: { inicio: '09:30', fim: '16:00' },
    criada_em: agora,
  });
  await salvarApiPlataforma('TT', {
    api_key_ia: '',
    tt_client_id: '',
    tt_client_secret: '',
    tt_refresh_token: '',
    tt_account_id: '',
    tt_ambiente: '', // vazio = produção; 'cert' aponta para o sandbox
  });
  // Template da plataforma: mesma semente agnóstica de ativo do MB.
  const promptBase = readFileSync(new URL('../ia/promptBase.md', import.meta.url), 'utf8');
  await salvarTemplatePlataforma('TT', promptBase);
  log.info('plataforma Tastytrade semeada (sem ativos — cadastre pela dashboard)');
  return { semeado: true };
}

/**
 * Garante que a plataforma BINANCE existe na árvore V2 (semeadura única,
 * como garantirPlataformaTT). Nasce SEM ativos — o cadastro é feito pela
 * dashboard (tela da plataforma) — e sem credenciais: o dono preenche
 * API Key + Secret na dashboard antes de operar.
 * Nunca sobrescreve uma plataforma BN já existente (edições preservadas).
 */
export async function garantirPlataformaBN() {
  const existente = await obterPlataforma('BN');
  if (existente) return { semeado: false };

  const agora = new Date().toISOString();
  await salvarPlataforma('BN', {
    nome: 'Binance',
    ativa: true,
    tipo: 'exchange',
    conector: 'bn',
    timezone: 'America/Sao_Paulo',
    moeda: 'BRL', // pares em reais (BTCBRL…) — sem câmbio na moeda da plataforma
    criada_em: agora,
  });
  await salvarApiPlataforma('BN', {
    api_key_ia: '',
    bn_api_key: '',
    bn_api_secret: '',
  });
  // Template da plataforma: mesma semente agnóstica de ativo do MB/TT.
  const promptBase = readFileSync(new URL('../ia/promptBase.md', import.meta.url), 'utf8');
  await salvarTemplatePlataforma('BN', promptBase);
  log.info('plataforma Binance semeada (sem ativos — cadastre pela dashboard)');
  return { semeado: true };
}

/**
 * Garante que a plataforma TORO existe na árvore V2 (semeadura única, como
 * garantirPlataformaTT/BN). A Toro NÃO tem API — a plataforma nasce com
 * `assistida: true`: o robô analisa e RECOMENDA (via brapi.dev), mas quem
 * executa é o dono, registrando as operações pela dashboard. Nasce SEM
 * ativos (cadastro pela dashboard) e com a carteira manual zerada — o dono
 * informa o caixa na tela da plataforma.
 * Nunca sobrescreve uma plataforma TORO já existente (edições preservadas).
 */
export async function garantirPlataformaTORO() {
  const existente = await obterPlataforma('TORO');
  if (existente) return { semeado: false };

  const agora = new Date().toISOString();
  await salvarPlataforma('TORO', {
    nome: 'Toro (modo assistido)',
    ativa: true,
    tipo: 'corretora',
    conector: 'toro',
    // ASSISTIDA: o executor transforma aprovações do Motor em RECOMENDAÇÃO
    // (status `sugerida`) — nenhuma ordem é enviada nem simulada.
    assistida: true,
    timezone: 'America/Sao_Paulo',
    moeda: 'BRL',
    // Janela heurística do pregão da B3 (o conector não tem estadoMercado():
    // feriados não são cobertos — dia sem pregão só gera análises sem variação).
    pregao: { inicio: '10:00', fim: '18:00' },
    criada_em: agora,
  });
  await salvarApiPlataforma('TORO', {
    api_key_ia: '',
    brapi_token: '', // token gratuito do brapi.dev (dados da B3)
  });
  // Carteira MANUAL zerada: o `saldos()` do conector lê daqui; o dono define
  // o caixa pela dashboard e as operações manuais mantêm o restante.
  await salvarEstadoPlataforma('TORO', {
    carteira_manual: { saldo_moeda: 0, saldos: {}, atualizada_em: agora },
  });
  // Template da plataforma: mesma semente agnóstica de ativo do MB/TT/BN.
  const promptBase = readFileSync(new URL('../ia/promptBase.md', import.meta.url), 'utf8');
  await salvarTemplatePlataforma('TORO', promptBase);
  log.info('plataforma Toro semeada em modo assistido (sem ativos — cadastre pela dashboard)');
  return { semeado: true };
}

/**
 * Garante que a plataforma STEAM existe na árvore V2 (semeadura única, como
 * garantirPlataformaTT/BN/TORO). Mercado da Comunidade Steam (skins do CS2)
 * em MODO ASSISTIDO: a Steam tem API de LEITURA, mas nenhuma de execução —
 * automatizar compra exigiria o cookie da conta do dono. O robô lê, analisa e
 * RECOMENDA; quem compra e vende é ele, no site.
 *
 * Nasce SEM itens: o dono marca na seção Steam da dashboard quais itens do
 * inventário devem ser analisados, e é a marcação que cria o ativo.
 *
 * A MOEDA é `BRLS` (carteira Steam), deliberadamente diferente de `BRL`: o
 * saldo da carteira Steam não pode ser sacado, então somá-lo ao patrimônio ou
 * compará-lo com o CDI seria mentira. Sem cotação em `global/cambio`, o código
 * que consolida em reais já deixa esta moeda de fora sozinho — o isolamento é
 * estrutural, não depende de ninguém lembrar de um flag.
 *
 * Nunca sobrescreve uma plataforma STEAM já existente (edições preservadas).
 */
export async function garantirPlataformaSTEAM() {
  const existente = await obterPlataforma('STEAM');
  if (existente) return { semeado: false };

  const agora = new Date().toISOString();
  await salvarPlataforma('STEAM', {
    nome: 'Steam (modo assistido)',
    ativa: true,
    tipo: 'mercado',
    conector: 'steam',
    // ASSISTIDA: aprovação do Motor vira RECOMENDAÇÃO, nunca ordem.
    assistida: true,
    timezone: 'America/Sao_Paulo',
    moeda: 'BRLS',
    moeda_steam: 7, // código de moeda da API da Steam: 7 = BRL
    // SteamID64 do dono (17 dígitos). Não é segredo — está na URL do perfil —,
    // por isso fica aqui e não em `dados/api`: a dashboard precisa poder lê-lo
    // e editá-lo, e o doc das credenciais é só-escrita pelo navegador (V7.1).
    steam_id64: '',
    appid: 730, // CS2
    // Esta plataforma NÃO recebe as regras gerais: elas falam de RSI, MACD e
    // candles, que não existem num mercado de skin. O texto dela é o template
    // (semente `.md/regras_steam.md`). Nenhuma proteção do Motor muda com isso.
    usaRegrasGerais: false,
    // O mercado da Steam não fecha.
    // Os três intervalos que o dono edita na seção Steam (minutos).
    intervalos: { analise_minutos: 60, precos_minutos: 60, noticias_minutos: 30 },
    criada_em: agora,
  });
  await salvarApiPlataforma('STEAM', {
    api_key_ia: '',
    steam_id64: '', // 17 dígitos; o inventário precisa estar PÚBLICO no perfil
  });
  // Carteira MANUAL zerada: `saldos()` lê daqui e o dono informa o saldo da
  // carteira Steam pela dashboard.
  await salvarEstadoPlataforma('STEAM', {
    carteira_manual: { saldo_moeda: 0, saldos: {}, atualizada_em: agora },
  });
  // Template da plataforma: semente PRÓPRIA (`.md/regras_steam.md`), não a
  // agnóstica dos demais (`promptBase.md`) — aquela fala de RSI, MACD e candles
  // de 15 minutos, e aqui nada disso existe. Como esta plataforma nasce com
  // `usaRegrasGerais: false`, este texto é a PRIMEIRA camada do prompt: se
  // ficasse vazio, a IA analisaria skin sem instrução nenhuma. Editável na
  // seção Steam da dashboard.
  const regrasSteam = readFileSync(new URL('../../.md/regras_steam.md', import.meta.url), 'utf8');
  await salvarTemplatePlataforma('STEAM', regrasSteam);
  log.info('plataforma Steam semeada em modo assistido (sem itens — marque-os na seção Steam)');
  return { semeado: true };
}

/**
 * Backfill ÚNICO e idempotente do campo `aberta_modo` nas posições
 * (V5_2_Plan.MD §4.2): posições de antes da V5.2 não têm o campo e ficariam
 * fora da query nova de posições abertas. Percorre TODAS as posições de todos
 * os ativos UMA vez (paga a leitura cheia uma única vez), grava
 * `aberta_modo` = modo (não fechada) | null (fechada) e marca a conclusão no
 * doc `global/migracoes` — os boots seguintes leem só o marcador.
 * Rodar DEPOIS de migrarV1paraV2 (as posições copiadas da V1 também precisam).
 */
export async function backfillPosicoesAbertaModo() {
  const marcador = await lerDocBruto('global', 'migracoes');
  if (marcador?.posicoes_aberta_modo_em) return { executado: false };

  let atualizadas = 0;
  for (const plataforma of await listarPlataformas()) {
    for (const ativo of await listarAtivos(plataforma.id)) {
      const caminho = `plataformas/${plataforma.id}/ativos/${ativo.id}/posicoes`;
      for (const { id, dados } of await listarColecaoBruta(caminho)) {
        if (dados.aberta_modo !== undefined) continue; // já tem o campo (nova ou já corrigida)
        const aberta = dados.status !== 'FECHADA' ? (dados.modo ?? 'simulacao') : null;
        await salvarDocBruto(caminho, id, { aberta_modo: aberta });
        atualizadas += 1;
      }
    }
  }
  await salvarDocBruto('global', 'migracoes', { posicoes_aberta_modo_em: new Date().toISOString() });
  if (atualizadas > 0) log.info(`backfill de aberta_modo concluído (${atualizadas} posições atualizadas)`);
  return { executado: true, posicoes_atualizadas: atualizadas };
}

/**
 * Executa a migração V1 → V2 (ou a semeadura inicial, em instalação nova).
 * Devolve { migrado: false, motivo } quando não há nada a fazer,
 * { migrado: true, resumo } com contadores, ou { migrado: true, retomada:
 * true, resumo } quando uma migração interrompida foi completada.
 */
export async function migrarV1paraV2() {
  const existente = await obterPlataforma(PLATAFORMA);
  if (existente?.migracao_concluida_em) {
    return { migrado: false, motivo: 'migração V2 já concluída' };
  }
  if (existente) {
    // Migração anterior interrompida no meio das cópias (ou concluída antes
    // do marcador existir): completa só o que falta, sem tocar em config/
    // template/estado — edições feitas pela dashboard são preservadas.
    log.aviso('migração V1 → V2 incompleta detectada — retomando as cópias pendentes');
    const resumo = await copiarColecoesHistoricas();
    await salvarPlataforma(PLATAFORMA, { migracao_concluida_em: new Date().toISOString() });
    log.info('migração V1 → V2 retomada e concluída', resumo);
    return { migrado: true, retomada: true, resumo };
  }

  const agora = new Date().toISOString();
  const configV1 = await lerDocBruto('config', 'bot');
  const estadoV1 = (await lerDocBruto('estado', 'bot')) ?? {};
  const temDadosV1 = configV1 !== null;
  log.info(temDadosV1 ? 'migrando dados da V1 para a árvore V2…' : 'instalação nova — semeando a árvore V2');

  // ------------------------------------------------------------- plataforma MB
  await salvarPlataforma(PLATAFORMA, {
    nome: 'Mercado Bitcoin',
    ativa: true,
    tipo: 'exchange_cripto',
    conector: 'mb',
    timezone: 'America/Sao_Paulo',
    moeda: 'BRL',
    ...(Array.isArray(configV1?.modelos_ia) && configV1.modelos_ia.length > 0
      ? { modelos_ia: configV1.modelos_ia }
      : {}),
    criada_em: agora,
    ...(temDadosV1 ? { migrada_da_v1_em: agora } : {}),
  });

  await salvarApiPlataforma(PLATAFORMA, {
    api_key_ia: configV1?.api_key_ia ?? '',
    api_key_id: configV1?.api_key_mb_id ?? '',
    api_key_secret: configV1?.api_key_mb_secret ?? '',
  });

  // Template da plataforma: conteúdo do promptBase.md do repositório (a fonte
  // única passa a ser o Firestore — editável pela dashboard).
  const promptBase = readFileSync(new URL('../ia/promptBase.md', import.meta.url), 'utf8');
  await salvarTemplatePlataforma(PLATAFORMA, promptBase);

  // Carteira virtual: V1 era por ativo único; V2 é por plataforma
  // (um saldo na moeda + um saldo por ativo — V2_Plan.MD §B.3).
  const cs = estadoV1.carteira_simulacao ?? null;
  const sync = estadoV1.sincronizacao_saldos_reais ?? null;
  const inicioDiaV1 = estadoV1.patrimonio_inicio_dia ?? null;
  await salvarEstadoPlataforma(PLATAFORMA, {
    carteira_virtual: cs
      ? {
          saldo_moeda: cs.saldo_brl,
          saldos: { [ATIVO_V1]: cs.saldo_btc },
          inicializada_em: cs.inicializada_em ?? agora,
        }
      : null,
    sincronizacao_saldos_reais: sync
      ? { saldo_moeda: sync.saldo_brl, saldos: { [ATIVO_V1]: sync.saldo_btc }, em: sync.em ?? agora }
      : null,
    // Circuit breaker: na V2 a referência é POR PLATAFORMA e por modo.
    patrimonio_inicio_dia: inicioDiaV1
      ? { [inicioDiaV1.modo ?? 'simulacao']: { data: inicioDiaV1.data, valor: inicioDiaV1.valor } }
      : null,
  });

  // ------------------------------------------------------------------- ativos
  for (const seed of SEEDS_ATIVOS_MB) {
    const configMigrada =
      temDadosV1 && seed.id === ATIVO_V1
        ? {
            tempo_entre_analises_minutos: configV1.tempo_entre_analises_minutos,
            percentual_minimo_variacao: configV1.percentual_minimo_variacao,
            percentual_max_diferenca_execucao: configV1.percentual_max_diferenca_execucao,
            tempo_reset_dias: configV1.tempo_reset_dias,
            taxa_compra_percentual: configV1.taxa_compra_percentual,
            taxa_venda_percentual: configV1.taxa_venda_percentual,
            limite_perda_diaria_percentual: configV1.limite_perda_diaria_percentual,
            modo_simulacao: configV1.modo_simulacao,
          }
        : {};
    // Remove campos ausentes na V1 (assumem o padrão do código, como sempre).
    for (const [chave, valor] of Object.entries(configMigrada)) {
      if (valor === undefined) delete configMigrada[chave];
    }
    await salvarAtivo(PLATAFORMA, seed.id, {
      manifest: {
        ...MANIFEST_PADRAO,
        ...seed.manifest,
        intervaloPadrao: configMigrada.tempo_entre_analises_minutos ?? MANIFEST_PADRAO.intervaloPadrao,
        resetPadraoDias: configMigrada.tempo_reset_dias ?? MANIFEST_PADRAO.resetPadraoDias,
      },
      config: { ...CONFIG_ATIVO_PADRAO, ...seed.config, ...configMigrada },
    });
  }

  // Estado de runtime do BTC (baseline do filtro, última decisão).
  await salvarEstadoAtivo(PLATAFORMA, ATIVO_V1, {
    preco_ultima_analise: estadoV1.preco_ultima_analise ?? null,
    horario_ultima_analise: estadoV1.horario_ultima_analise ?? null,
    horario_ultima_verificacao: estadoV1.horario_ultima_verificacao ?? null,
    proxima_analise_em: estadoV1.proxima_analise_em ?? null,
    ultima_decisao_ia: estadoV1.ultima_decisao_ia ?? null,
  });

  // Estatísticas por modo (campos monetários renomeados para os genéricos).
  for (const modo of ['simulacao', 'real']) {
    const stats = await lerDocBruto('estatisticas', modo);
    if (stats) await salvarEstatisticasAtivo(PLATAFORMA, ATIVO_V1, modo, converterCampos(stats));
  }

  // Históricos: operações e posições preservam o id do documento
  // (op_YYYYMMDD_HHMMSS / pos_YYYYMMDD_HHMMSS); histórico usa id automático
  // com dedupe por `horario` (retomada segura).
  const resumo = await copiarColecoesHistoricas();

  // Marcador de conclusão SEMPRE por último: se o processo cair antes daqui,
  // a próxima inicialização retoma as cópias pendentes.
  await salvarPlataforma(PLATAFORMA, { migracao_concluida_em: new Date().toISOString() });
  log.info('migração V1 → V2 concluída', resumo);
  return { migrado: true, resumo };
}
