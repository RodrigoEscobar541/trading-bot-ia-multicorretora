// orquestrador.js — agenda e roda os ciclos de TODOS os ativos de TODAS as
// plataformas (V2_Plan.MD §B.2): o processo acorda a cada minuto e executa EM
// SÉRIE os ativos cujo intervalo venceu — nunca dois ciclos simultâneos
// (evita disputa pelo mesmo caixa e pelo rate limit da plataforma).
//
// Cada ativo tem seu próprio intervalo, filtro de variação e baseline (config
// do ativo). Ativos com `mercado24h: false` (bolsa) não rodam fora do pregão.
// Falha em um ativo é logada e NÃO impede os demais — e nada derruba o loop.

import { readFileSync } from 'node:fs';
import {
  obterEstadoAtivo,
  salvarEstadoAtivo,
  salvarEstadoPlataforma,
  salvarStatusBot,
  obterControle,
  salvarControle,
  obterRelatorioDecisoes,
  salvarRelatorioDecisoes,
  obterSupervisao,
  salvarApiMeta,
  mascararApi,
} from '../firebase/firebaseClient.js';
import { plataformasCache, apiCache, ativosCache, telegramCache, supervisorConfigCache, invalidarCatalogo } from './catalogo.js';
import {
  notificarProblema,
  notificarRecuperacao,
  notificarRelatorio,
  notificarSupervisao,
  notificarModoVendas,
  confirmarAtivacao,
  ultimoResultadoEnvio,
} from '../notificacoes/telegram.js';
import {
  gerarRelatorioDecisoes,
  formatarRelatorio,
  INTERVALO_RELATORIO_MS,
} from './relatorioDecisoes.js';
import { deveSupervisionar, rodarSupervisao, formatarSupervisao, naJanelaDeQuota } from './supervisor.js';
import { filtrarPlataformas, ehPrimario } from './instancia.js';
import { criarConector } from '../conectores/conector.js';
import { estadoModoVendas } from '../regras/regrasEngine.js';
import { executarCicloAtivo } from './cicloAtivo.js';
import { atualizarRendaReal, atualizarCambio } from './rendaReal.js';
import { atualizarInventario } from './inventarioSteam.js';
import { verificarNoticias } from './noticiasJogo.js';
import { log } from '../utils/logger.js';

const TICK_MS = 60_000; // granularidade do agendador: 1 minuto
const TOLERANCIA_MS = 5_000; // evita perder um ciclo por poucos ms de deriva

// Janela heurística do pregão para ativos sem mercado 24h, usada como
// FALLBACK quando o conector da plataforma não informa o estado do mercado
// (método opcional `estadoMercado()` — cobre feriados e meio-pregão direto
// da corretora). A janela é configurável no doc da plataforma
// (`pregao: { inicio: 'HH:MM', fim: 'HH:MM' }`, fim exclusivo).
const PREGAO_PADRAO = { inicio: '10:00', fim: '18:00' };

/** 'HH:MM' → minutos desde a meia-noite (formato inválido cai no padrão). */
function minutosDoDia(horario, padrao = null) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(horario ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : padrao;
}

/** O ativo pode operar AGORA? (mercado 24h sempre pode; bolsa só no pregão) */
export function dentroDoHorarioDeMercado(manifest, agora = new Date(), timezone = 'America/Sao_Paulo', pregao = {}) {
  if (manifest.mercado24h !== false) return true;
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(agora);
  const de = (tipo) => partes.find((p) => p.type === tipo)?.value;
  const diaUtil = !['Sat', 'Sun'].includes(de('weekday'));
  const minutos = Number(de('hour')) * 60 + Number(de('minute'));
  const inicio = minutosDoDia(pregao?.inicio, minutosDoDia(PREGAO_PADRAO.inicio));
  const fim = minutosDoDia(pregao?.fim, minutosDoDia(PREGAO_PADRAO.fim));
  return diaUtil && minutos >= inicio && minutos < fim;
}

/** O intervalo do ativo já venceu desde a última análise/verificação? */
export function deveAnalisarAgora({ config, estado, agora = new Date() }) {
  const ultima = [estado.horario_ultima_verificacao, estado.horario_ultima_analise]
    .filter(Boolean)
    .sort()
    .at(-1);
  if (!ultima) return true; // nunca rodou
  const intervaloMs = (Number(config.tempo_entre_analises_minutos) || 15) * 60_000;
  return agora.getTime() - new Date(ultima).getTime() >= intervaloMs - TOLERANCIA_MS;
}

// Status da conexão com cada plataforma: verificado 1×/hora quando está OK e
// persistido em `plataformas/{P}/dados/estado.conexao` para a dashboard.
// Depois de uma FALHA, reconfere a cada 5 min — quem acabou de corrigir as
// chaves na dashboard vê o ✅ em minutos, não em uma hora.
const VERIFICACAO_CONEXAO_MS = 60 * 60_000;
const REVERIFICACAO_FALHA_MS = 5 * 60_000;
const conexaoVerificadaEm = new Map(); // plataformaId → epoch ms
const conexaoUltimoOk = new Map(); // plataformaId → boolean (loga só transições)

/**
 * Verifica (1×/hora, melhor esforço) se as credenciais da plataforma
 * autenticam, usando `saldos()` — chamada autenticada barata que existe em
 * todo conector. Só roda quando há alguma credencial de corretora
 * configurada, para não gerar erro em plataformas recém-semeadas.
 */
async function verificarConexaoPlataforma(plataforma, api, conector) {
  const temCredencial = Object.entries(api ?? {}).some(
    ([campo, valor]) => campo !== 'api_key_ia' && typeof valor === 'string' && valor,
  );
  if (!temCredencial) return;
  const ultima = conexaoVerificadaEm.get(plataforma.id) ?? 0;
  const intervalo =
    conexaoUltimoOk.get(plataforma.id) === false ? REVERIFICACAO_FALHA_MS : VERIFICACAO_CONEXAO_MS;
  if (Date.now() - ultima < intervalo) return;
  conexaoVerificadaEm.set(plataforma.id, Date.now());

  let conexao;
  try {
    await conector.saldos();
    conexao = { ok: true, erro: null, verificado_em: new Date().toISOString() };
  } catch (e) {
    conexao = { ok: false, erro: e.message, verificado_em: new Date().toISOString() };
  }
  if (conexaoUltimoOk.get(plataforma.id) !== conexao.ok) {
    const msg = `plataforma ${plataforma.id}: autenticação ${conexao.ok ? 'OK' : `FALHOU (${conexao.erro})`}`;
    if (conexao.ok) log.info(msg);
    else log.aviso(msg);
    // Aviso no Telegram só na TRANSIÇÃO (esta função já roda 1×/hora quando
    // está OK): corretora que caiu, e depois que voltou. Best-effort.
    await avisarConexao(plataforma, conexao);
  }
  conexaoUltimoOk.set(plataforma.id, conexao.ok);
  await publicarMetaApi(plataforma.id);
  try {
    await salvarEstadoPlataforma(plataforma.id, { conexao });
  } catch (e) {
    log.aviso(`não foi possível persistir o status de conexão de ${plataforma.id}`, e);
  }
}

/**
 * Gera e envia o relatório de decisões quando a janela vence. A régua é o
 * `gerado_em` PERSISTIDO: um reinício do bot não gera relatório fora de hora
 * nem empurra o próximo para frente.
 *
 * Na primeira execução (nenhum relatório anterior) NÃO dispara: espera uma
 * janela cheia, senão o primeiro sairia com dados parciais e assustaria à toa.
 */
async function gerarRelatorioSeVencido() {
  const anterior = await obterRelatorioDecisoes();
  const agora = Date.now();
  if (!anterior?.gerado_em) {
    // Marca o início da primeira janela sem enviar nada.
    await salvarRelatorioDecisoes({ gerado_em: new Date(agora).toISOString(), janela: null, primeira: true });
    log.info('relatório de decisões: primeira janela iniciada — o primeiro relatório sai em 7 dias');
    return;
  }
  if (agora - new Date(anterior.gerado_em).getTime() < INTERVALO_RELATORIO_MS) return;

  const relatorio = await gerarRelatorioDecisoes({ agora: new Date(agora) });
  log.info('relatório de decisões gerado', {
    vendas: relatorio.vendas,
    compras: relatorio.compras,
    decisoes: relatorio.decisoes?.total,
  });
  try {
    await notificarRelatorio({ texto: formatarRelatorio(relatorio), config: await telegramCache() });
  } catch (e) {
    log.aviso('falha ao enviar o relatório de decisões no Telegram', e);
  }
}

/**
 * Roda a SUPERVISÃO SEMANAL (V7.2) quando é hora — ou agora, se o dono pediu
 * pela dashboard. Trabalho GLOBAL: só a instância primária.
 *
 * Ordem das portas, da mais barata para a mais cara:
 *   1. config (catálogo, sem leitura nova) — supervisor desligado, nem começa;
 *   2. `naJanelaDeQuota` (função pura) — fora da madrugada do Pacífico, o doc
 *      nem é lido, então nas ~18 h restantes isto custa ZERO leitura;
 *   3. só então lê `global/supervisao` para conferir se os 7 dias venceram.
 *
 * Falha aqui nunca é fatal: a camada de prompt anterior continua valendo, que
 * é exatamente o comportamento seguro.
 */
async function supervisionarSeVencido({ forcar = false, modoVendas = null } = {}) {
  const config = await supervisorConfigCache();
  if (config.ativo === false && !forcar) return;
  if (!forcar && !naJanelaDeQuota()) return;

  // Pedido manual é consumido ANTES de rodar: se a rodada falhar, o pedido não
  // fica preso repetindo a cada tick (e uma chamada de IA por tick seria caro).
  // Vale também quando o pedido vai ser RECUSADO logo abaixo (modo vendas):
  // deixá-lo pendurado faria a liquidação terminar e disparar, dias depois, uma
  // supervisão que o dono pediu e já esqueceu.
  if (forcar) {
    try {
      await salvarControle({ supervisao_solicitada: false, supervisao_solicitada_em: null });
    } catch (e) {
      log.aviso('não foi possível limpar o pedido manual de supervisão — seguindo', e);
    }
  }

  // MODO VENDAS (V8): a decisão de pausar mora em `deveSupervisionar` (função
  // pura, testável); aqui só se paga a leitura que ela precisa. Nada é apagado —
  // desligar o modo traz o supervisor de volta, e a régua dos 7 dias continua
  // sendo o `gerado_em` persistido.
  const supervisao = await obterSupervisao();
  const { rodar, motivo } = deveSupervisionar({ supervisao, forcar, config, modoVendas });
  if (!rodar) {
    if (modoVendas?.ativo && forcar) log.aviso(`supervisão pedida pela dashboard foi recusada: ${motivo}`);
    return;
  }

  log.info(`supervisão semanal: iniciando (${motivo})`);
  const resultado = await rodarSupervisao();
  if (!resultado.ok) {
    log.aviso(`supervisão semanal não concluída: ${resultado.motivo} — camada anterior mantida`);
    return;
  }
  try {
    await notificarSupervisao({
      texto: formatarSupervisao(resultado.supervisao),
      config: await telegramCache(),
    });
  } catch (e) {
    log.aviso('falha ao enviar a supervisão semanal no Telegram', e);
  }
}

// Último espelho publicado por plataforma, para não reescrever o mesmo doc.
const metaApiPublicada = new Map();

/**
 * Publica o espelho MASCARADO das credenciais (`dados/api_meta`) — é o que a
 * dashboard lê para mostrar "configurada (…1234)", já que `dados/api` deixou de
 * ser legível pelo navegador. Escreve só quando o conteúdo muda: no boot e
 * depois de o dono trocar alguma chave. Nunca lança.
 */
async function publicarMetaApi(plataformaId) {
  try {
    const api = await apiCache(plataformaId);
    const meta = mascararApi(api);
    const assinatura = JSON.stringify(meta);
    if (metaApiPublicada.get(plataformaId) === assinatura) return;
    await salvarApiMeta(plataformaId, meta);
    metaApiPublicada.set(plataformaId, assinatura);
  } catch (e) {
    log.aviso(`falha ao publicar o espelho das credenciais de ${plataformaId}`, e);
  }
}

/** Avisa no Telegram que a quota da IA acabou. Nunca lança. */
async function avisarQuotaIA(plataforma) {
  try {
    const config = await telegramCache();
    await notificarProblema({
      chave: `quota_ia:${plataforma.id}`,
      titulo: 'Quota da IA esgotada',
      detalhe:
        `Todos os modelos da cadeia de ${plataforma.nome ?? plataforma.id} falharam. ` +
        'As análises ficam paradas até a quota renovar (meia-noite no horário do Pacífico).',
      config,
    });
  } catch (e) {
    log.aviso('falha ao avisar a quota da IA no Telegram', e);
  }
}

/** Avisa no Telegram que uma corretora caiu (ou voltou). Nunca lança. */
async function avisarConexao(plataforma, conexao) {
  try {
    const config = await telegramCache();
    const chave = `conexao:${plataforma.id}`;
    if (conexao.ok) {
      await notificarRecuperacao({ chave, titulo: `${plataforma.nome ?? plataforma.id}: conexão restabelecida`, config });
    } else {
      await notificarProblema({
        chave,
        titulo: `${plataforma.nome ?? plataforma.id}: falha de autenticação`,
        detalhe: conexao.erro ?? '',
        config,
      });
    }
  } catch (e) {
    log.aviso(`falha ao avisar o status de conexão de ${plataforma.id} no Telegram`, e);
  }
}

// Último estado de mercado persistido por plataforma (grava só transições —
// evita uma escrita por minuto no Firestore).
const mercadoPersistido = new Map(); // plataformaId → 'aberto'|'fechado'

// Estado de runtime de cada ativo em MEMÓRIA (V5_2_Plan.MD §2.2): o doc
// `dados/estado` do ativo é escrito SÓ pelo bot (a dashboard apenas lê), então
// o orquestrador o lê do Firestore UMA vez por boot e depois confia na cópia
// devolvida por cada ciclo. INVARIANTE: nenhum código fora de
// cicloAtivo/orquestrador pode escrever nesse doc — se um dia precisar,
// invalidar este mapa junto, ou o agendamento passa a usar dado velho.
const estadoAtivos = new Map(); // `${plataformaId}/${ativoId}` → estado

/** Esvazia o estado em memória (testes — a persistência é recriada entre eles). */
export function limparEstadoAtivosEmMemoria() {
  estadoAtivos.clear();
}

/**
 * O estado em memória precisa ser DESCARTADO agora? Pura de propósito: a
 * decisão é testável sem relógio nem Firestore.
 *
 * POR QUE EXISTE: o mapa acima é a única cópia de `dados/estado` que o bot
 * consulta, e o Firestore só é lido no boot. Quando algo APAGA esses documentos
 * por fora — hoje só `scripts/resetar-dados.mjs` — a memória fica com o retrato
 * antigo e o processo segue filtrando a variação contra um preço que não existe
 * mais e REGRAVANDO os contadores de decisão pré-reset nos documentos recém
 * nascidos. Foi o que aconteceu no reset de 2026-07-27: 5 ativos voltaram a
 * gravar `decisoes_acumuladas` de 25/07, e o primeiro relatório da janela nova
 * publicaria decisões de antes do reset como se fossem dela. É exatamente a
 * contaminação que o reset existe para evitar, entrando pela porta que o
 * comentário do mapa acima já avisava estar aberta.
 *
 * A marca viaja em `global/controle.estado_invalidado_em` — doc que o tick JÁ lê
 * fresco a cada minuto, então isto não custa nenhuma leitura nova (invariante
 * V5.2), mesma carona do modo vendas e do "rodar supervisão agora".
 *
 * `vista === undefined` é o PRIMEIRO tick do processo: apenas ANOTA, nunca
 * limpa. O boot leu o estado do Firestore agora há pouco; limpar ali só pagaria
 * uma leitura extra por ativo a cada reinício.
 */
export function deveLimparEstadoEmMemoria(marca, vista) {
  if (vista === undefined) return false;
  return (marca ?? null) !== (vista ?? null);
}

/**
 * Estado do pregão da plataforma, quando o conector o informa
 * (`estadoMercado()` — cobre feriados/meio-pregão). Devolve o objeto do
 * conector ou null (aí vale a janela heurística por fuso/horário).
 */
async function obterMercadoDaPlataforma(plataforma, conector, ligados) {
  const temBolsa = ligados.some((a) => a.manifest.mercado24h === false);
  if (!temBolsa || typeof conector.estadoMercado !== 'function') return null;
  try {
    const mercado = await conector.estadoMercado();
    const situacao = mercado.aberto ? 'aberto' : 'fechado';
    if (mercadoPersistido.get(plataforma.id) !== situacao) {
      mercadoPersistido.set(plataforma.id, situacao);
      try {
        await salvarEstadoPlataforma(plataforma.id, {
          mercado: { ...mercado, verificado_em: new Date().toISOString() },
        });
      } catch (e) {
        log.aviso(`não foi possível persistir o estado do mercado de ${plataforma.id}`, e);
      }
    }
    return mercado;
  } catch (e) {
    log.aviso(`plataforma ${plataforma.id}: falha ao consultar o pregão — usando janela heurística`, e);
    return null;
  }
}

/**
 * Uma varredura: percorre plataformas ativas e roda, EM SÉRIE, os ativos
 * ligados cujo intervalo venceu. Devolve um resumo por ativo executado.
 * `decidirFn` é injetável para testes.
 */
export async function executarRodada({ agora = new Date(), decidirFn, modoVendas = null, forcarInventario = false } = {}) {
  const resumo = [];
  // Config vem do catálogo cacheado (TTL 5 min) — o tick de 1 min não relê
  // plataformas/chaves/ativos do Firestore (V5_2_Plan.MD §2.1). O filtro por
  // BOT_PLATAFORMAS escopa esta instância (arquitetura de dois bots por
  // região; ver DoisBots_Plan.MD) — vazio = todas.
  const plataformas = filtrarPlataformas(
    (await plataformasCache()).filter((p) => p.ativa !== false),
    process.env.BOT_PLATAFORMAS,
  );

  for (const plataforma of plataformas) {
    let api;
    let conector;
    try {
      api = await apiCache(plataforma.id);
      conector = criarConector(plataforma, api);
    } catch (e) {
      log.erro(`plataforma ${plataforma.id} sem conector utilizável — pulando`, e);
      continue;
    }

    await verificarConexaoPlataforma(plataforma, api, conector);

    // Plataformas com INVENTÁRIO (hoje a Steam): o bot lê a lista de itens do
    // dono e publica o retrato para a dashboard, que não consegue ler a Steam
    // direto (sem CORS). O gate é a CAPACIDADE do conector, nunca o nome da
    // plataforma — o núcleo não conhece "STEAM" (CLAUDE.md §16). A própria
    // função decide se o intervalo venceu e nunca lança.
    if (typeof conector.inventario === 'function') {
      await atualizarInventario({
        plataforma,
        conector,
        agoraMs: agora.getTime(),
        forcar: forcarInventario,
        configTelegram: await telegramCache(), // alertas de preço-alvo
      });
    }

    // Atualizações do JOGO (fase 2 da Steam): num mercado de skin, notícia do
    // jogo é o fundamento. Mesmo gate por capacidade, mesmo contrato de nunca
    // lançar, e a config do Telegram vem do catálogo cacheado — notificar não
    // pode custar leitura por evento (V5.2).
    let noticiaNova = false;
    if (typeof conector.noticias === 'function') {
      const r = await verificarNoticias({
        plataforma,
        conector,
        agoraMs: agora.getTime(),
        configTelegram: await telegramCache(),
      });
      noticiaNova = (r.novas?.length ?? 0) > 0;
      // A camada de notícias do prompt vem do catálogo cacheado (TTL 5 min).
      // Com anúncio novo o cache precisa cair AGORA, senão a análise que ele
      // acabou de forçar leria o documento anterior — analisaria sem a notícia
      // que é o motivo da análise.
      if (noticiaNova) invalidarCatalogo();
    }

    const ativos = await ativosCache(plataforma.id);
    const ligados = ativos.filter((a) => a.config.ativo !== false);

    // Pregão: preferir o estado informado pela corretora (feriados, meio-
    // pregão); sem ele, cada ativo cai na janela heurística da plataforma.
    const mercado = await obterMercadoDaPlataforma(plataforma, conector, ligados);

    for (const ativo of ligados) {
      const aberto =
        ativo.manifest.mercado24h !== false
          ? true
          : mercado
            ? mercado.aberto
            : dentroDoHorarioDeMercado(ativo.manifest, agora, plataforma.timezone, plataforma.pregao);
      if (!aberto) continue;

      // Estado do ativo: 1 leitura por boot; depois vive em memória (§2.2).
      const chaveEstado = `${plataforma.id}/${ativo.id}`;
      let estado = estadoAtivos.get(chaveEstado);
      if (!estado) {
        estado = await obterEstadoAtivo(plataforma.id, ativo.id);
        estadoAtivos.set(chaveEstado, estado);
      }
      if (!deveAnalisarAgora({ config: ativo.config, estado, agora })) continue;

      try {
        const resultado = await executarCicloAtivo({
          plataforma,
          api,
          ativo,
          ativosDaPlataforma: ligados,
          conector,
          estado,
          modoVendas, // liquidação (V8) — null quando o modo está desligado
          // Saiu atualização do jogo nesta rodada: os ativos desta plataforma
          // analisam mesmo sem o preço ter se mexido (o preço se move DEPOIS
          // da notícia, e é justamente isso que se quer avaliar antes).
          forcarAnalise: noticiaNova,
          ...(decidirFn ? { decidirFn } : {}),
        });
        if (resultado.estado) estadoAtivos.set(chaveEstado, resultado.estado);
        resumo.push({ plataforma: plataforma.id, ativo: ativo.id, tipo: resultado.tipo });
      } catch (e) {
        // Falha de UM ativo nunca derruba a rodada (CLAUDE.md §3.1). O ciclo
        // pode ter gravado estado antes de falhar: descarta a cópia em memória
        // para o próximo tick reler do Firestore (senão um erro persistente
        // pós-IA viraria uma nova chamada de IA POR MINUTO).
        estadoAtivos.delete(chaveEstado);
        log.erro(`[${plataforma.id}/${ativo.id}] ciclo falhou — pulando para o próximo ativo`, e);
        resumo.push({ plataforma: plataforma.id, ativo: ativo.id, tipo: 'erro' });
        // Cadeia de IA esgotada trava as análises até a quota renovar (meia-noite
        // do Pacífico) e se repetiria a cada ciclo de cada ativo — por isso a
        // chave do anti-spam é por PLATAFORMA, não por ativo.
        if (e?.cadeiaEsgotada) {
          await avisarQuotaIA(plataforma);
        }
      }

      // Contagem regressiva da dashboard (melhor esforço).
      try {
        const minutos = Number(ativo.config.tempo_entre_analises_minutos) || 15;
        const proxima = new Date(agora.getTime() + minutos * 60_000).toISOString();
        await salvarEstadoAtivo(plataforma.id, ativo.id, { proxima_analise_em: proxima });
        const emMemoria = estadoAtivos.get(chaveEstado);
        if (emMemoria) estadoAtivos.set(chaveEstado, { ...emMemoria, proxima_analise_em: proxima });
      } catch (e) {
        log.erro(`[${plataforma.id}/${ativo.id}] falha ao registrar a próxima análise`, e);
      }
    }
  }
  return resumo;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Comparativo de renda real × 106% do CDI (global/renda_real): recalculado a
// cada 15 min no loop eterno — fora do executarRodada de propósito, para os
// testes de rodada não dependerem de rede (Selic) nem do doc global.
const RENDA_REAL_MS = 15 * 60_000;
let rendaRealAtualizadaEm = 0;

// De quanto em quanto tempo o bot CONFERE se a supervisão semanal venceu (a
// rodada em si é 1×/semana). 15 min é folgado: a janela de quota tem 6 h.
const SUPERVISAO_CHECK_MS = 15 * 60_000;
let supervisaoVerificadaEm = 0;

/**
 * Commit que ESTE processo está rodando. Existe porque "o código novo já subiu?"
 * foi pergunta sem resposta duas vezes em 2026-07-25 — com `versao` do
 * package.json (que quase nunca muda) não dava para distinguir bot atualizado de
 * bot velho reiniciado. Preferência: `BOT_COMMIT`, exportado pelo
 * scripts/vps-deploy.sh; fallback: ler o `.git` local (desenvolvimento).
 */
function commitAtual() {
  if (process.env.BOT_COMMIT) return process.env.BOT_COMMIT.trim().slice(0, 7);
  try {
    const raiz = new URL('../../.git/', import.meta.url);
    const head = readFileSync(new URL('HEAD', raiz), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 7);
    return readFileSync(new URL(head.slice(5).trim(), raiz), 'utf8').trim().slice(0, 7);
  } catch {
    return null; // sem .git (container, tarball) — o campo simplesmente fica null
  }
}
const BOT_COMMIT = commitAtual();

// Momento em que ESTE processo subiu (uptime do heartbeat).
const BOT_INICIADO_EM = new Date().toISOString();

/**
 * Objeto de heartbeat do bot (doc `global/status_bot`) — puro e testável. A
 * dashboard usa `atualizado_em` para dizer se o PROCESSO está vivo agora.
 */
export function montarStatusBot({ agora = new Date(), ultimaRodada = null, travado = false, modoVendas = null } = {}) {
  return {
    atualizado_em: agora.toISOString(),
    iniciado_em: BOT_INICIADO_EM,
    versao: process.env.npm_package_version ?? null,
    // Qual CÓDIGO está no ar. Responde "o deploy pegou?" sem SSH na VPS.
    commit: BOT_COMMIT,
    instancia: process.env.BOT_PLATAFORMAS || 'todas',
    primario: ehPrimario(),
    // Confirma para a dashboard que o BOT viu a parada de emergência (não só
    // que o flag foi escrito) — V6.2.
    travado,
    // Mesma ideia para a liquidação (V8): a dashboard escreve o flag, mas quem
    // confirma o dia e a tolerância VIGENTES é o bot — o número que aparece na
    // tela é o mesmo que o Motor está usando, não uma conta refeita no
    // navegador que poderia divergir por fuso ou por relógio.
    modo_vendas: modoVendas
      ? { ativo: true, dia: modoVendas.dia, dias_totais: modoVendas.dias_totais, perda_maxima_percentual: modoVendas.perda_maxima_percentual }
      : { ativo: false },
    ultima_rodada: ultimaRodada,
    // Resultado do último envio ao Telegram. Pega carona no heartbeat (que já é
    // escrito a cada minuto e NÃO passa pelo catálogo) em vez de escrever no
    // doc `global/telegram` — esse é cacheado, e gravá-lo exigiria invalidar o
    // catálogo inteiro a cada aviso. Assim um chat id errado aparece na TELA,
    // em vez de morrer no log do pm2.
    telegram: ultimoResultadoEnvio(),
  };
}

/** Loop eterno do orquestrador: falha de rodada nunca derruba o processo. */
export async function iniciarOrquestrador() {
  const primario = ehPrimario();
  log.info(
    `orquestrador multi-ativo iniciado (tick de 1 minuto)` +
      (process.env.BOT_PLATAFORMAS ? ` — plataformas: ${process.env.BOT_PLATAFORMAS}` : '') +
      (primario ? ' [primário: renda_real × CDI ligado]' : ' [secundário]'),
  );
  let ultimaRodada = null; // última rodada NÃO vazia (mostrada no heartbeat)
  let avisouTravado = false; // loga a transição travado/destravado uma vez
  let avisouModoVendas = false; // idem para a liquidação (V8)
  // Marca de invalidação do estado em memória vista no tick anterior.
  // `undefined` = ainda nenhum tick leu o controle (ver deveLimparEstadoEmMemoria).
  let invalidacaoVista;
  // Marca do último pedido de "atualizar inventário agora" já atendido.
  // `undefined` = nenhum tick leu ainda; o primeiro só ANOTA (o inventário já
  // é montado no boot de qualquer forma, e reiniciar o bot não deve refazer um
  // pedido antigo).
  let inventarioPedidoVisto;
  for (;;) {
    // Parada de emergência (V6.2): lido FRESCO a cada tick (fora do catálogo —
    // precisa ser responsivo), custo ~1 leitura/min. Travado → pula a rodada
    // inteira (nenhuma análise, nenhuma ordem), mas o heartbeat segue vivo.
    let travado = false;
    let pedidoSupervisao = false;
    let pedidoInventario;
    let modoVendas = null;
    // Só compara a marca de invalidação quando a LEITURA deu certo: falha de
    // rede não pode virar "a marca mudou" e jogar fora o estado de todos os
    // ativos (o que custaria uma releitura por ativo por tick).
    let marcaInvalidacao;
    try {
      const controle = await obterControle();
      travado = controle?.operacao_travada === true;
      marcaInvalidacao = controle?.estado_invalidado_em ?? null;
      // "Rodar a supervisão agora", pedido pela dashboard. Pega carona nesta
      // leitura que já acontece todo tick — um doc próprio custaria mais 1.440
      // leituras/dia só para um botão que se usa de vez em quando (V5.2).
      pedidoSupervisao = controle?.supervisao_solicitada === true;
      // "Atualizar o inventário agora", botão da tela da Steam. Mesma carona,
      // e por MARCA (um ISO) em vez de booleano: o bot não precisa escrever
      // nada para "consumir" o pedido — basta lembrar qual marca já viu.
      pedidoInventario = controle?.inventario_solicitado_em ?? null;
      // Liquidação (V8), mesma carona. Resolvido a cada tick porque a tolerância
      // do dia é função do relógio: virar o dia tem de mudar o número sem
      // ninguém reiniciar nada.
      modoVendas = estadoModoVendas(controle, new Date());
    } catch (e) {
      log.aviso('falha ao ler a parada de emergência (global/controle) — seguindo normalmente', e);
    }
    if (Boolean(modoVendas) !== avisouModoVendas) {
      log.aviso(
        modoVendas
          ? `💰 MODO VENDAS ligado (dia ${modoVendas.dia}/${modoVendas.dias_totais}, tolerância de hoje ${modoVendas.perda_maxima_percentual}%) — compras bloqueadas, supervisor pausado`
          : '▶ modo vendas desligado — operação normal retomada',
      );
      avisouModoVendas = Boolean(modoVendas);
    }
    if (travado !== avisouTravado) {
      log.aviso(travado ? '⛔ OPERAÇÃO TRAVADA pela dashboard — rodadas pausadas' : '▶ operação destravada — rodadas retomadas');
      avisouTravado = travado;
    }
    // Estado apagado por fora (reset de dados): descarta a cópia em memória
    // ANTES da rodada, para o próximo ciclo reler do Firestore. Fica fora do
    // `if (!travado)` de propósito — o reset trava a operação justamente
    // enquanto apaga, e é nessa janela que a marca chega.
    if (marcaInvalidacao !== undefined) {
      if (deveLimparEstadoEmMemoria(marcaInvalidacao, invalidacaoVista)) {
        limparEstadoAtivosEmMemoria();
        log.aviso(
          'estado em memória descartado: os documentos `dados/estado` foram apagados por fora ' +
            `(marca ${marcaInvalidacao ?? 'removida'}) — o próximo ciclo relê tudo do Firestore`,
        );
      }
      invalidacaoVista = marcaInvalidacao;
    }

    // Pedido manual de atualização do inventário: só vale quando a marca MUDOU
    // em relação à que este processo já atendeu.
    let forcarInventario = false;
    if (pedidoInventario !== undefined) {
      forcarInventario = inventarioPedidoVisto !== undefined && pedidoInventario !== inventarioPedidoVisto;
      inventarioPedidoVisto = pedidoInventario;
    }

    if (!travado) {
      try {
        const resumo = await executarRodada({ modoVendas, forcarInventario });
        if (resumo.length > 0) {
          ultimaRodada = resumo.map((r) => `${r.plataforma}/${r.ativo}:${r.tipo}`).join(', ');
          log.info(`rodada concluída: ${ultimaRodada}`);
        }
      } catch (e) {
        log.erro('rodada do orquestrador falhou — tentando novamente no próximo tick', e);
      }
    }
    // Confirma no Telegram que os avisos estão ligados — uma vez por
    // configuração. Lê do CATÁLOGO (cacheado): nenhuma leitura nova por tick.
    // ANTES do heartbeat de propósito: o resultado do envio viaja NELE, e
    // inverter a ordem faria a dashboard mostrar sempre o estado do tick
    // anterior — foi o que fez um erro já corrigido parecer persistente.
    try {
      await confirmarAtivacao({ config: await telegramCache() });
    } catch (e) {
      log.aviso('falha ao confirmar a ativação dos avisos do Telegram', e);
    }
    // Lembrete diário da liquidação (V8). O modo não expira sozinho, então quem
    // cobra presença é o aviso: a trava anti-spam de 24 h por chave já é o
    // "uma vez por dia", sem agendador novo. Só o primário, para não duplicar.
    if (primario) {
      try {
        await notificarModoVendas({ estado: modoVendas ?? { ativo: false }, config: await telegramCache() });
      } catch (e) {
        log.aviso('falha ao avisar sobre o modo vendas no Telegram', e);
      }
    }
    // Heartbeat: registra a cada tick que o processo está vivo (dashboard).
    // Best-effort — falha de escrita nunca derruba o loop.
    try {
      await salvarStatusBot(montarStatusBot({ ultimaRodada, travado, modoVendas }));
    } catch (e) {
      log.aviso('falha ao gravar o heartbeat do bot (status_bot)', e);
    }
    // renda_real × CDI é trabalho GLOBAL (agrega TODAS as plataformas do
    // Firestore): só a instância PRIMÁRIA recalcula, para não duplicar a
    // escrita quando há dois bots (DoisBots_Plan.MD).
    if (primario && Date.now() - rendaRealAtualizadaEm >= RENDA_REAL_MS) {
      rendaRealAtualizadaEm = Date.now();
      // Câmbio USD→BRL PRIMEIRO: além de consolidar o patrimônio multi-moeda da
      // visão geral (V6.2), a cotação fresca é usada pelo comparativo × CDI para
      // converter os lucros em moeda estrangeira para BRL. Global → só a
      // instância primária grava.
      try {
        await atualizarCambio();
      } catch (e) {
        log.aviso('falha ao atualizar o câmbio para consolidação do patrimônio', e);
      }
      try {
        await atualizarRendaReal();
      } catch (e) {
        log.aviso('falha ao atualizar o comparativo de renda real × CDI', e);
      }
      // Relatório de decisões: também trabalho GLOBAL e só do primário. A
      // periodicidade é decidida pelo `gerado_em` do próprio doc, não por um
      // contador em memória — assim reiniciar o bot não dispara um relatório
      // novo nem atrasa o próximo.
      try {
        await gerarRelatorioSeVencido();
      } catch (e) {
        log.aviso('falha ao gerar o relatório de decisões', e);
      }
    }
    // Supervisão semanal (V7.2): também global e só do primário. Fora do gate
    // dos 15 min porque o pedido MANUAL da dashboard precisa ser atendido no
    // tick seguinte, não em até 15 minutos.
    if (primario && (pedidoSupervisao || Date.now() - supervisaoVerificadaEm >= SUPERVISAO_CHECK_MS)) {
      supervisaoVerificadaEm = Date.now();
      try {
        await supervisionarSeVencido({ forcar: pedidoSupervisao, modoVendas });
      } catch (e) {
        log.aviso('falha na supervisão semanal — a camada de prompt anterior continua valendo', e);
      }
    }
    await dormir(TICK_MS);
  }
}
