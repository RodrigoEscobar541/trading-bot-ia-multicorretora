// rendaReal.js — comparativo do rendimento REAL do robô com a renda fixa
// (106% do CDI, com a Selic consultada na API pública do Banco Central).
//
// Considera APENAS ativos com `modo_simulacao: false` (lucro do doc
// `estatisticas_real` de cada um) — simulação nunca entra na conta. O
// resultado vive no doc `global/renda_real`, que também carrega o campo
// pedido `lucro_real_total` / `lucro_real_por_moeda` (total de lucro só dos
// ativos fora da simulação). A comparação começa no momento em que o PRIMEIRO
// ativo entra em modo real (`inicio_comparacao`, fixado uma única vez).
//
// Decisões documentadas:
//   - Selic: série SGS 432 (meta Selic % a.a.) — API aberta do BCB, sem chave.
//     Falha na API → mantém a última taxa persistida; sem nenhuma → um padrão
//     conservador do código. A taxa é reconsultada no máximo a cada 6 h.
//   - CDI ≈ Selic − 0,10 p.p. (o DI historicamente roda logo abaixo da meta).
//   - 106% do CDI capitaliza como na renda fixa: taxa DIÁRIA do CDI × 1,06,
//     composta em 252 dias úteis/ano.
//   - O rendimento do BENCHMARK no período é acumulado só em DIAS ÚTEIS (base
//     252) — o CDI não rende em fim de semana nem feriado nacional. Sábados,
//     domingos e feriados (calendário bancário brasileiro, com os móveis via
//     Páscoa) não somam nada. As taxas de referência ano/mês/semana continuam
//     conversões teóricas da taxa a.a. (não é cálculo de rentabilidade fiscal).
//   - O rendimento do robô em % usa como principal o patrimônio do MODO na
//     largada (`patrimonio_inicio_dia[modo]`, melhor esforço). Esse número é
//     medido só com os ativos DAQUELE modo (V8.14): no modo real ele NÃO inclui
//     as posições dos ativos que rodam em simulação, nem a carteira virtual.
//     Referência medida sob a regra ANTIGA (sem o carimbo `base`, quando o
//     patrimônio somava os dois modos) é RECUSADA e o principal é re-medido —
//     senão o comparativo ficaria dividindo o lucro real por um principal
//     inflado com dinheiro virtual (era o caso até a V8.15).
//     Aportes/saques posteriores distorcem o comparativo (limitação aceita).
//   - O principal soma as MESMAS carteiras que o numerador: toda plataforma com
//     ativo no modo, convertida para BRL pelo câmbio do BCB. Moeda sem cotação
//     fica de fora dos DOIS lados. Plataforma do modo que não entrou (sem
//     referência ainda, carimbo velho ou moeda sem câmbio) é reportada em
//     `patrimonio_inicial_fora` — o principal é parcial e a dashboard diz isso.
//   - O comparativo é na moeda da Selic (BRL). O lucro de cada moeda continua
//     registrado NA SUA MOEDA em `lucro_real_por_moeda` (o cabeçalho da
//     dashboard mostra "R$ … · US$ …"), mas o TOTAL comparado com o CDI soma
//     tudo em BRL: moeda estrangeira é convertida pelo câmbio do BCB (mesmo doc
//     `global/cambio` da consolidação do patrimônio). Moeda sem cotação
//     disponível fica de fora do total (melhor esforço, nunca chuta um câmbio)
//     e é reportada em `moedas_sem_cambio` para a dashboard avisar.

import {
  obterEstatisticasAtivo,
  obterEstadoPlataforma,
  obterRendaReal,
  salvarRendaReal,
  obterCambio,
  salvarCambio,
  obterConfigRenda,
} from '../firebase/firebaseClient.js';
import { BASE_PATRIMONIO } from '../executor/executor.js';
import { plataformasCache, ativosCache } from './catalogo.js';
import { log } from '../utils/logger.js';

const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v === null || v === undefined ? null : Math.round(v * 10000) / 10000);

/** Percentual do CDI usado como benchmark (pedido do projeto: 106%). */
export const PERCENTUAL_CDI = 106;

/** Meta Selic % a.a. usada se a API do BCB nunca respondeu (referência 2026). */
export const SELIC_FALLBACK_AA = 15;

/** Reconsulta a Selic na API no máximo a cada 6 horas. */
const SELIC_TTL_MS = 6 * 60 * 60_000;

/** Série 432 do SGS/BCB: meta Selic definida pelo Copom (% a.a.). */
const URL_SELIC_BCB =
  'https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json';

// ------------------------------------------------------------ matemática pura

/** CDI aproximado a partir da meta Selic (% a.a.): 0,10 p.p. abaixo, nunca < 0. */
export const cdiDaSelic = (selicAA) => Math.max(0, selicAA - 0.1);

/**
 * Taxa anual do benchmark "X% do CDI" (% a.a.): o percentual aplica sobre a
 * taxa DIÁRIA do CDI (base 252), composta de volta para o ano — é assim que
 * a renda fixa pós-fixada rende, e dá um pouco mais que multiplicar a anual.
 */
export function benchmarkAA(cdiAA, percentualCDI = PERCENTUAL_CDI) {
  const diaria = (1 + cdiAA / 100) ** (1 / 252) - 1;
  return ((1 + (percentualCDI / 100) * diaria) ** 252 - 1) * 100;
}

/** Taxa equivalente de `dias` corridos a partir de uma taxa % a.a. (juros compostos). */
export function taxaEquivalente(taxaAA, dias) {
  return ((1 + taxaAA / 100) ** (dias / 365) - 1) * 100;
}

/**
 * Taxa equivalente de `diasUteis` DIAS ÚTEIS a partir de uma taxa % a.a., na
 * base 252 (é assim que o CDI acumula: só em dia útil). Usada no rendimento do
 * benchmark no período, para que fim de semana/feriado não somem juros.
 */
export function taxaEquivalenteDiasUteis(taxaAA, diasUteis) {
  return ((1 + taxaAA / 100) ** (diasUteis / 252) - 1) * 100;
}

// ------------------------------------------------------ calendário de dias úteis

const pad2 = (n) => String(n).padStart(2, '0');
/** Chave 'YYYY-MM-DD' de uma data pelos componentes UTC. */
const chaveDia = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/**
 * Domingo de Páscoa (UTC) do ano — algoritmo de Computus (Meeus/Jones/Butcher).
 * Base para os feriados móveis (Carnaval, Sexta-feira Santa, Corpus Christi).
 */
export function domingoDePascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31); // 3 = março, 4 = abril
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const _feriadosPorAno = new Map();

/**
 * Feriados nacionais/bancários do ano (calendário do CDI), como Set de
 * 'YYYY-MM-DD'. Inclui os fixos e os móveis derivados da Páscoa. Cacheado.
 */
export function feriadosBrasil(ano) {
  if (_feriadosPorAno.has(ano)) return _feriadosPorAno.get(ano);
  const pascoa = domingoDePascoa(ano);
  const desloca = (dias) => {
    const dt = new Date(pascoa);
    dt.setUTCDate(dt.getUTCDate() + dias);
    return chaveDia(dt);
  };
  const set = new Set([
    `${ano}-01-01`, // Confraternização Universal
    desloca(-48), // Carnaval (segunda-feira)
    desloca(-47), // Carnaval (terça-feira)
    desloca(-2), // Sexta-feira Santa
    `${ano}-04-21`, // Tiradentes
    `${ano}-05-01`, // Dia do Trabalho
    desloca(60), // Corpus Christi
    `${ano}-09-07`, // Independência
    `${ano}-10-12`, // Nossa Senhora Aparecida
    `${ano}-11-02`, // Finados
    `${ano}-11-15`, // Proclamação da República
    `${ano}-11-20`, // Consciência Negra (feriado nacional desde 2024)
    `${ano}-12-25`, // Natal
  ]);
  _feriadosPorAno.set(ano, set);
  return set;
}

/** true se a data (UTC) é sábado, domingo ou feriado nacional. */
function ehDiaNaoUtil(d) {
  const dow = d.getUTCDay(); // 0 = domingo, 6 = sábado
  if (dow === 0 || dow === 6) return true;
  return feriadosBrasil(d.getUTCFullYear()).has(chaveDia(d));
}

/**
 * Conta os DIAS ÚTEIS decorridos entre `inicio` e `fim` (o CDI só rende em dia
 * útil). Conta por DATA em UTC: o dia de `inicio` é a base e não conta; cada dia
 * útil seguinte, até a data de `fim`, soma 1 (fim de semana/feriado somam 0).
 * Menos de 24 h no mesmo dia → 0. Aproximação informativa (fuso UTC).
 */
export function diasUteisEntre(inicio, fim) {
  const ini = new Date(inicio);
  const f = new Date(fim);
  if (!(f > ini)) return 0;
  const cursor = new Date(Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth(), ini.getUTCDate()));
  const fimDia = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate()));
  let contador = 0;
  cursor.setUTCDate(cursor.getUTCDate() + 1); // pula o dia da largada (base)
  while (cursor <= fimDia) {
    if (!ehDiaNaoUtil(cursor)) contador += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return contador;
}

/** Anualiza um rendimento % obtido em `dias` corridos (juros compostos). */
export function taxaAnualizada(rendimentoPct, dias) {
  if (!Number.isFinite(rendimentoPct) || !(dias > 0)) return null;
  const base = 1 + rendimentoPct / 100;
  if (base <= 0) return null; // perda >= 100% não anualiza
  return (base ** (365 / dias) - 1) * 100;
}

/** Desdobra uma taxa % a.a. nos períodos exibidos: ano, mês e semana. */
export function taxasPorPeriodo(taxaAA) {
  return {
    ano: r2(taxaAA),
    mes: r2(((1 + taxaAA / 100) ** (1 / 12) - 1) * 100),
    semana: r2(taxaEquivalente(taxaAA, 7)),
  };
}

// ----------------------------------------------------------------- Selic (BCB)

/**
 * Meta Selic % a.a., com a cadeia de fallback documentada acima. Devolve
 * { taxa_aa, fonte: 'api_bcb'|'anterior'|'padrao', consultada_em }.
 * `fetchFn` é injetável para testes.
 */
export async function obterSelicAA({ fetchFn = fetch, anterior = null, agora = new Date() } = {}) {
  try {
    const resposta = await fetchFn(URL_SELIC_BCB, { signal: AbortSignal.timeout(10_000) });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    const serie = await resposta.json();
    const bruto = serie?.at(-1)?.valor;
    const taxa = Number(String(bruto).replace(',', '.'));
    if (!Number.isFinite(taxa) || taxa <= 0) throw new Error(`valor inesperado: ${bruto}`);
    return { taxa_aa: taxa, fonte: 'api_bcb', consultada_em: agora.toISOString() };
  } catch (e) {
    log.aviso('não foi possível consultar a Selic na API do BCB — usando a última conhecida', e);
    if (Number.isFinite(anterior?.taxa_aa)) {
      return { ...anterior, fonte: 'anterior' };
    }
    return { taxa_aa: SELIC_FALLBACK_AA, fonte: 'padrao', consultada_em: agora.toISOString() };
  }
}

// ----------------------------------------------------------------- câmbio (V6.2)
// Consolidação do patrimônio em UMA moeda (BRL) na visão geral: cotação USD→BRL
// (PTAX venda) da API aberta do BCB, mesma cadeia de fallback da Selic. Só
// exibição — nenhuma decisão/operação usa isto.

/** Cotação USD→BRL de fallback se a API do BCB nunca respondeu (referência 2026). */
export const USD_FALLBACK_BRL = 5.5;

/** Reconsulta o câmbio no máximo a cada 6 horas. */
const CAMBIO_TTL_MS = 6 * 60 * 60_000;

/** Série 1 do SGS/BCB: dólar americano (venda), diário. */
const URL_USD_BCB =
  'https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados/ultimos/1?formato=json';

/**
 * Cotação USD→BRL na API aberta do BCB. Devolve { taxa_brl, fonte,
 * consultada_em } com a mesma cadeia de fallback da Selic. `fetchFn` injetável.
 */
export async function obterCotacaoUSD({ fetchFn = fetch, anterior = null, agora = new Date() } = {}) {
  try {
    const resposta = await fetchFn(URL_USD_BCB, { signal: AbortSignal.timeout(10_000) });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    const serie = await resposta.json();
    const bruto = serie?.at(-1)?.valor;
    const taxa = Number(String(bruto).replace(',', '.'));
    if (!Number.isFinite(taxa) || taxa <= 0) throw new Error(`valor inesperado: ${bruto}`);
    return { taxa_brl: taxa, fonte: 'api_bcb', consultada_em: agora.toISOString() };
  } catch (e) {
    log.aviso('não foi possível consultar o câmbio USD na API do BCB — usando o último conhecido', e);
    if (Number.isFinite(anterior?.taxa_brl)) return { ...anterior, fonte: 'anterior' };
    return { taxa_brl: USD_FALLBACK_BRL, fonte: 'padrao', consultada_em: agora.toISOString() };
  }
}

/**
 * Atualiza o doc `global/cambio` (só exibição): cotação USD→BRL reaproveitada
 * enquanto recente (TTL 6 h). Devolve o doc salvo. `agora`/`fetchFn` injetáveis.
 */
export async function atualizarCambio({ agora = new Date(), fetchFn = fetch } = {}) {
  const anterior = await obterCambio();
  let usd = anterior?.USD ?? null;
  const vencida =
    !usd?.consultada_em || agora.getTime() - new Date(usd.consultada_em).getTime() >= CAMBIO_TTL_MS;
  if (vencida || !Number.isFinite(usd?.para_brl)) {
    const nova = await obterCotacaoUSD({
      fetchFn,
      anterior: usd ? { taxa_brl: usd.para_brl, consultada_em: usd.consultada_em } : null,
      agora,
    });
    usd = { para_brl: r4(nova.taxa_brl), fonte: nova.fonte, consultada_em: nova.consultada_em };
  }
  const doc = { base: 'BRL', USD: usd, atualizado_em: agora.toISOString() };
  await salvarCambio(doc);
  return doc;
}

// --------------------------------------------------------------- agregação

/**
 * Soma o lucro realizado POR MOEDA no MODO dado ('real' | 'simulacao'),
 * considerando só os ativos daquele modo. Devolve também as plataformas que TÊM
 * ativo no modo, com a moeda de cada uma — é dessa lista que sai o principal do
 * comparativo, para que denominador e numerador cubram as MESMAS carteiras.
 */
async function agregarModo(plataformas, modo, agoraMs) {
  const ehReal = modo === 'real';
  const porMoeda = {};
  const plataformasDoModo = [];
  let existe = false;
  for (const plataforma of plataformas) {
    const moeda = plataforma.moeda ?? 'BRL';
    const ativos = await ativosCache(plataforma.id, { agoraMs });
    const doModo = ativos.filter((a) => (a.config.modo_simulacao === false) === ehReal);
    if (doModo.length === 0) continue;
    existe = true;
    plataformasDoModo.push({ id: plataforma.id, moeda });
    for (const ativo of doModo) {
      const stats = await obterEstatisticasAtivo(plataforma.id, ativo.id, modo);
      porMoeda[moeda] = (porMoeda[moeda] ?? 0) + (stats.lucro_total ?? 0);
    }
  }
  return { existe, porMoeda, plataformasDoModo };
}

/**
 * Converte o lucro POR MOEDA num total em BRL usando o câmbio do BCB (doc
 * `global/cambio`, a mesma cotação da consolidação do patrimônio). BRL entra
 * direto; cada moeda estrangeira multiplica pela cotação `para_brl`. Moeda sem
 * cotação disponível fica DE FORA do total (melhor esforço — nunca chuta um
 * câmbio) e é reportada em `moedasSemCambio` para a dashboard avisar.
 */
export function converterLucroParaBRL(lucroPorMoeda, cambio) {
  let total = 0;
  const moedasSemCambio = [];
  for (const [moeda, valor] of Object.entries(lucroPorMoeda ?? {})) {
    if (!Number.isFinite(valor)) continue;
    if (moeda === 'BRL') {
      total += valor;
      continue;
    }
    const taxa = cambio?.[moeda]?.para_brl;
    if (Number.isFinite(taxa) && taxa > 0) {
      total += valor * taxa;
    } else if (valor !== 0) {
      moedasSemCambio.push(moeda);
    }
  }
  return { total, moedasSemCambio };
}

/**
 * Mede o PRINCIPAL do comparativo (em BRL): a soma do patrimônio de largada das
 * plataformas que têm ativo no modo. Cada parcela vem de
 * `patrimonio_inicio_dia[modo]`, a referência diária do circuit breaker — que
 * desde a V8.14 é medida SÓ com os ativos daquele modo (carimbo `base`).
 *
 * O que fica de FORA, e por quê:
 *   - referência sem o carimbo da regra atual: foi medida quando o patrimônio
 *     somava os dois modos, então carrega posição de ativo simulado. Entrar com
 *     ela é pior que ficar sem: infla o principal e some com o % do robô.
 *   - plataforma sem referência ainda (nunca rodou um ciclo no modo — é o caso
 *     das assistidas paradas): nada a somar.
 *   - moeda estrangeira sem cotação no doc `global/cambio`: mesma régua do
 *     lucro (§ decisões, topo do arquivo) — nunca se chuta um câmbio.
 *
 * Devolve { valor, plataformas, fora, medido_em }: `valor` é null quando
 * nenhuma parcela pôde ser medida (tentamos de novo no próximo recálculo);
 * `fora` lista as plataformas do modo que não entraram, para a dashboard poder
 * dizer que o principal é parcial.
 */
async function medirPrincipal({ plataformasDoModo, modo, cambio }) {
  let soma = 0;
  let achou = false;
  const plataformas = [];
  const fora = [];
  let medidoEm = null;
  for (const { id, moeda } of plataformasDoModo) {
    const ref = (await obterEstadoPlataforma(id)).patrimonio_inicio_dia?.[modo];
    if (!Number.isFinite(ref?.valor) || ref.base !== BASE_PATRIMONIO) {
      fora.push(id);
      continue;
    }
    const taxa = moeda === 'BRL' ? 1 : cambio?.[moeda]?.para_brl;
    if (!Number.isFinite(taxa) || taxa <= 0) {
      fora.push(id);
      continue;
    }
    soma += ref.valor * taxa;
    achou = true;
    plataformas.push(id);
    if (ref.data && (medidoEm === null || ref.data > medidoEm)) medidoEm = ref.data;
  }
  return { valor: achou ? r2(soma) : null, plataformas, fora, medido_em: medidoEm };
}

/**
 * Monta um bloco de comparação (robô × 106% do CDI) para um modo. Devolve null
 * quando o modo nunca teve ativo E a comparação nunca começou. `anteriorBloco`
 * carrega a régua já fixada (início/principal/lucro por moeda anteriores).
 * `cambio` (doc `global/cambio`) converte os lucros em moeda estrangeira p/ BRL.
 */
async function montarBloco({ anteriorBloco, agregado, benchAA, agora, modo, cambio }) {
  const { existe, porMoeda, plataformasDoModo } = agregado;

  // Zera moedas já conhecidas (uma moeda que saiu do modo vai a 0, não congela
  // o valor antigo — o doc é salvo com merge).
  const lucroPorMoeda = {};
  for (const m of Object.keys(anteriorBloco?.lucro_por_moeda ?? {})) lucroPorMoeda[m] = 0;
  for (const [m, v] of Object.entries(porMoeda)) lucroPorMoeda[m] = (lucroPorMoeda[m] ?? 0) + v;
  for (const m of Object.keys(lucroPorMoeda)) lucroPorMoeda[m] = r2(lucroPorMoeda[m]);

  if (!existe && !anteriorBloco?.inicio_comparacao) return null;

  // Início: fixado UMA vez (quando o modo passa a ter dados) e nunca recua.
  const inicio = anteriorBloco?.inicio_comparacao ?? agora.toISOString();

  // Principal: fixado UMA vez, como o início — mas só vale enquanto tiver o
  // carimbo da regra ATUAL. Um principal salvo sob a regra antiga (patrimônio
  // dos dois modos juntos) é descartado e re-medido: é exatamente o número que
  // fazia o comparativo real dividir o lucro por dinheiro virtual.
  const carimbadoNaRegraAtual = anteriorBloco?.patrimonio_inicial_base === BASE_PATRIMONIO;
  let patrimonioInicial = carimbadoNaRegraAtual ? (anteriorBloco?.patrimonio_inicial ?? null) : null;
  let principalPlataformas = carimbadoNaRegraAtual ? (anteriorBloco?.patrimonio_inicial_plataformas ?? []) : [];
  let principalFora = carimbadoNaRegraAtual ? (anteriorBloco?.patrimonio_inicial_fora ?? []) : [];
  let principalMedidoEm = carimbadoNaRegraAtual ? (anteriorBloco?.patrimonio_inicial_medido_em ?? null) : null;
  if (patrimonioInicial === null) {
    const medido = await medirPrincipal({ plataformasDoModo, modo, cambio });
    patrimonioInicial = medido.valor;
    principalPlataformas = medido.plataformas;
    principalFora = medido.fora;
    principalMedidoEm = medido.medido_em;
  }

  const dias = Math.max(0, (agora.getTime() - new Date(inicio).getTime()) / 86_400_000);
  // Dias ÚTEIS decorridos: o CDI só rende em dia útil, então o rendimento do
  // benchmark no período usa estes (base 252) — fim de semana/feriado não somam.
  const diasUteis = diasUteisEntre(inicio, agora);
  const rendBenchPeriodo = taxaEquivalenteDiasUteis(benchAA, diasUteis);
  // Total comparado com o CDI em BRL: soma o lucro de TODAS as moedas,
  // convertendo as estrangeiras pelo câmbio do BCB (§ decisões, topo do arquivo).
  const { total: lucroBRLbruto, moedasSemCambio } = converterLucroParaBRL(lucroPorMoeda, cambio);
  const lucroBRL = r2(lucroBRLbruto);
  // Robô: rendimento % no período sobre o principal; anualiza só com >= 1 dia.
  const botPeriodo = patrimonioInicial > 0 ? (lucroBRL / patrimonioInicial) * 100 : null;
  const botAA = dias >= 1 && botPeriodo !== null ? taxaAnualizada(botPeriodo, dias) : null;

  return {
    lucro_total: lucroBRL,
    lucro_por_moeda: lucroPorMoeda,
    moedas_sem_cambio: moedasSemCambio,
    moeda_comparacao: 'BRL',
    inicio_comparacao: inicio,
    dias_comparacao: r2(dias),
    dias_uteis_comparacao: diasUteis,
    patrimonio_inicial: patrimonioInicial,
    // De ONDE saiu o principal (a dashboard mostra no rodapé): a regra sob a
    // qual foi medido, quais carteiras entraram, quais ficaram de fora e a data
    // da referência mais recente usada.
    patrimonio_inicial_base: patrimonioInicial === null ? null : BASE_PATRIMONIO,
    patrimonio_inicial_plataformas: principalPlataformas,
    patrimonio_inicial_fora: principalFora,
    patrimonio_inicial_medido_em: principalMedidoEm,
    comparativo: {
      bot: {
        periodo: r2(botPeriodo),
        ...(botAA !== null ? taxasPorPeriodo(botAA) : { ano: null, mes: null, semana: null }),
      },
      benchmark: {
        periodo: r2(rendBenchPeriodo),
        ...taxasPorPeriodo(benchAA),
      },
      lucro_bot: r2(lucroBRL),
      rendimento_benchmark:
        patrimonioInicial > 0 ? r2(patrimonioInicial * (rendBenchPeriodo / 100)) : null,
    },
  };
}

/**
 * Recalcula o comparativo × 106% do CDI para os DOIS modos e persiste em
 * `global/renda_real` (V6.2): o bloco REAL fica no TOPO do doc (compat + o
 * campo pedido `lucro_real_total`); o bloco SIMULAÇÃO fica em `simulacao`. Sem
 * dados em nenhum modo (e sem comparação já iniciada), devolve null. Selic é
 * consultada uma vez e vale para os dois. `agora`/`fetchFn` injetáveis.
 */
export async function atualizarRendaReal({ agora = new Date(), fetchFn = fetch } = {}) {
  const anterior = await obterRendaReal();
  // Plataformas/ativos vêm do catálogo cacheado (V5_2_Plan.MD §2.3) — este
  // recálculo roda a cada 15 min e não precisa de config mais fresca que o TTL.
  const agoraMs = agora.getTime();
  const plataformas = await plataformasCache({ agoraMs });

  const agReal = await agregarModo(plataformas, 'real', agoraMs);
  const agSim = await agregarModo(plataformas, 'simulacao', agoraMs);

  // Câmbio (doc `global/cambio`) para converter lucros em moeda estrangeira p/
  // BRL no total do comparativo. É só LEITURA aqui — o orquestrador atualiza o
  // câmbio ANTES deste recálculo; ausente (1ª execução), a moeda estrangeira
  // fica de fora do total até a próxima rodada (reportada em moedas_sem_cambio).
  const cambio = await obterCambio();

  const temReal = agReal.existe || anterior?.inicio_comparacao;
  const temSim = agSim.existe || anterior?.simulacao?.inicio_comparacao;
  if (!temReal && !temSim) return null;

  // Ajustes MANUAIS do comparativo (doc `global/config_renda`, editável pela
  // dashboard): Selic fixada pelo dono e/ou percentual do CDI do benchmark.
  const configRenda = await obterConfigRenda();
  const selicManual =
    Number.isFinite(configRenda?.selic_manual) && configRenda.selic_manual > 0
      ? configRenda.selic_manual
      : null;
  const percentualCDI =
    Number.isFinite(configRenda?.percentual_cdi) && configRenda.percentual_cdi > 0
      ? configRenda.percentual_cdi
      : PERCENTUAL_CDI;

  // Selic: a manual (do dono) sobrepõe tudo; senão usa a persistida enquanto
  // recente e, fora do TTL, volta à API do BCB. Ao trocar de manual para API
  // (ou vice-versa), força a reconsulta para não congelar a taxa antiga.
  let selicBase = anterior?.selic ?? null;
  if (selicManual !== null) {
    selicBase = { taxa_aa: selicManual, fonte: 'manual', consultada_em: agora.toISOString() };
  } else {
    const eraManual = selicBase?.fonte === 'manual';
    const vencida =
      eraManual ||
      !selicBase?.consultada_em ||
      agora.getTime() - new Date(selicBase.consultada_em).getTime() >= SELIC_TTL_MS;
    if (vencida || !Number.isFinite(selicBase?.taxa_aa)) {
      selicBase = await obterSelicAA({ fetchFn, anterior: selicBase, agora });
    }
  }
  const cdiAA = cdiDaSelic(selicBase.taxa_aa);
  const benchAA = benchmarkAA(cdiAA, percentualCDI);

  // A régua REAL vive no topo do doc; a de simulação em `simulacao`.
  const anteriorReal = {
    inicio_comparacao: anterior?.inicio_comparacao ?? null,
    patrimonio_inicial: anterior?.patrimonio_inicial ?? null,
    patrimonio_inicial_base: anterior?.patrimonio_inicial_base ?? null,
    patrimonio_inicial_plataformas: anterior?.patrimonio_inicial_plataformas ?? [],
    patrimonio_inicial_fora: anterior?.patrimonio_inicial_fora ?? [],
    patrimonio_inicial_medido_em: anterior?.patrimonio_inicial_medido_em ?? null,
    lucro_por_moeda: anterior?.lucro_real_por_moeda ?? {},
  };
  const blocoReal = await montarBloco({ anteriorBloco: anteriorReal, agregado: agReal, benchAA, agora, modo: 'real', cambio });
  const blocoSim = await montarBloco({ anteriorBloco: anterior?.simulacao, agregado: agSim, benchAA, agora, modo: 'simulacao', cambio });

  const doc = {
    // Bloco REAL no topo (campo pedido lucro_real_total; nomes mantidos).
    ...(blocoReal
      ? {
          lucro_real_total: blocoReal.lucro_total,
          lucro_real_por_moeda: blocoReal.lucro_por_moeda,
          moedas_sem_cambio: blocoReal.moedas_sem_cambio,
          moeda_comparacao: 'BRL',
          inicio_comparacao: blocoReal.inicio_comparacao,
          dias_comparacao: blocoReal.dias_comparacao,
          dias_uteis_comparacao: blocoReal.dias_uteis_comparacao,
          patrimonio_inicial: blocoReal.patrimonio_inicial,
          patrimonio_inicial_base: blocoReal.patrimonio_inicial_base,
          patrimonio_inicial_plataformas: blocoReal.patrimonio_inicial_plataformas,
          patrimonio_inicial_fora: blocoReal.patrimonio_inicial_fora,
          patrimonio_inicial_medido_em: blocoReal.patrimonio_inicial_medido_em,
          comparativo: blocoReal.comparativo,
        }
      : {}),
    // Bloco SIMULAÇÃO paralelo (V6.2): mesma estrutura, régua independente.
    ...(blocoSim ? { simulacao: blocoSim } : {}),
    selic: {
      taxa_aa: r2(selicBase.taxa_aa),
      cdi_aa: r2(cdiAA),
      percentual_cdi: percentualCDI,
      benchmark_aa: r2(benchAA),
      fonte: selicBase.fonte,
      consultada_em: selicBase.consultada_em,
    },
    atualizado_em: agora.toISOString(),
  };
  await salvarRendaReal(doc);
  return doc;
}
