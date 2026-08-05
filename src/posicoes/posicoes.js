// posicoes.js — posições independentes (lotes) (CLAUDE.md §11.1).
//
// Cada compra do robô abre uma POSIÇÃO com preço de entrada próprio; ativo que
// entra por fora (compra manual na plataforma ou depósito) vira posição de
// origem "externa" com custo-base = preço de mercado no momento da detecção.
// A regra "nunca vender no prejuízo" (regras.md §1.4) vale POR POSIÇÃO: uma
// posição antiga no prejuízo nunca impede a realização de lucro das demais.
//
// STOP-LOSS POR POSIÇÃO (V6.6): cada posição carrega o SEU chão (`stop_loss`),
// definido pela IA no momento da compra e ajustável só PARA CIMA depois
// (trailing). É a ÚNICA porta de venda no prejuízo do sistema, e quem a abre é
// o Motor de Regras — determinístico, sem consultar a IA. Posição sem
// `stop_loss` (as anteriores à V6.6, as externas e as manuais) segue na regra
// clássica: só vende com lucro.
//
// V2: as posições vivem na subcoleção `plataformas/{P}/ativos/{A}/posicoes` e
// TODAS as funções recebem o escopo (plataforma, ativo). Quantidades usam o
// campo genérico `quantidade` (unidade do ativo); valores em dinheiro, a moeda
// da plataforma. Nenhuma referência a BTC ou a qualquer ativo específico.
//
// Ciclo de vida de uma posição:
//   ABERTA      — recém-criada, ainda não reavaliada por uma análise
//   MONITORANDO — acompanhada; lucro líquido projetado ainda não é positivo
//   LUCRO       — lucro líquido projetado positivo (vendável)
//   VENDA       — ordem de venda real em andamento (entre criação e fill)
//   FECHADA     — vendida (ou zerada por saque externo)
// Na simulação a execução é instantânea: a posição pula direto para FECHADA.
//
// A fórmula do lucro continua sendo a normativa do Motor de Regras
// (calcularLucroLiquidoVenda) — aplicada ao preço de compra DA posição.

import {
  registrarPosicaoAtivo,
  atualizarPosicaoAtivo,
  obterPosicoesAbertasAtivo,
} from '../firebase/firebaseClient.js';
import { calcularLucroLiquidoVenda, taxaCompraPercentualEfetiva } from '../regras/regrasEngine.js';
import { timestampISO } from '../utils/formatador.js';
import { log } from '../utils/logger.js';

/** Status em que a posição pode ser oferecida à IA e vendida. */
export const STATUS_VENDAVEIS = new Set(['ABERTA', 'MONITORANDO', 'LUCRO']);

const arredondarQtd = (v) => Math.round(v * 1e8) / 1e8;
const arredondarValor = (v) => Math.round(v * 100) / 100;

// Diferenças menores que isso entre saldo e soma das posições são ruído de
// arredondamento (8 casas), não compra manual/depósito/saque.
const TOLERANCIA_QTD = 0.0000001;

/** Gera id no padrão pos_YYYYMMDD_HHMMSS (+ sufixo para desempate). */
export function gerarIdPosicao(data = new Date(), sufixo = '') {
  const p = (n) => String(n).padStart(2, '0');
  const ymd = `${data.getUTCFullYear()}${p(data.getUTCMonth() + 1)}${p(data.getUTCDate())}`;
  const hms = `${p(data.getUTCHours())}${p(data.getUTCMinutes())}${p(data.getUTCSeconds())}`;
  return `pos_${ymd}_${hms}${sufixo ? `_${sufixo}` : ''}`;
}

// ------------------------------------------------------------ funções puras

/**
 * Lucro líquido projetado se a posição inteira for vendida a `precoVenda`.
 * Perna de compra pela taxa EFETIVA do lote (já paga); perna de venda pela
 * estimativa conservadora da config — mesma convenção do Motor.
 */
export function lucroDaPosicao(posicao, precoVenda, config) {
  return calcularLucroLiquidoVenda({
    quantidade: posicao.quantidade,
    preco_venda: precoVenda,
    preco_compra: posicao.preco_compra,
    taxa_compra_percentual: taxaCompraPercentualEfetiva(posicao, config),
    taxa_venda_percentual: config.taxa_venda_percentual,
  });
}

// Breakeven real da posição (já com as duas pernas de taxa). A fórmula é
// única e vive no Motor de Regras — aqui só reexportadas, porque o JSON da IA
// e o trailing precisam falar do MESMO número.
export { precoMinimoVendaLucrativa, breakevenPosicao } from '../regras/regrasEngine.js';

/**
 * Reconciliação PURA entre o saldo do ativo na carteira e a soma das posições
 * não fechadas. Devolve o que deve ser feito (quem chama persiste):
 *   { nova: {quantidade, preco_compra}|null, reducoes: [{id, quantidade, fechar}] }
 *
 * - saldo MAIOR que a soma → ativo entrou por fora (compra manual/depósito):
 *   nova posição externa ao preço atual (mesma regra conservadora da
 *   inicialização da simulação). Sobras menores que o mínimo operacional
 *   viram posição mesmo assim (ficam aguardando — nunca somem em silêncio).
 * - saldo MENOR → ativo saiu por fora (saque/venda manual): abate primeiro das
 *   posições externas, depois das mais antigas (FIFO); posição zerada fecha.
 */
export function reconciliarComSaldo(posicoes, saldo, precoAtual) {
  const abertas = posicoes.filter((p) => p.status !== 'FECHADA');
  const soma = arredondarQtd(abertas.reduce((s, p) => s + p.quantidade, 0));
  const delta = arredondarQtd(saldo - soma);

  if (Math.abs(delta) <= TOLERANCIA_QTD) return { nova: null, reducoes: [] };

  if (delta > 0) {
    return { nova: { quantidade: delta, preco_compra: precoAtual }, reducoes: [] };
  }

  // Saída externa: externas primeiro, depois FIFO pela abertura.
  const ordenadas = [...abertas].sort((a, b) => {
    if (a.origem !== b.origem) return a.origem === 'externa' ? -1 : 1;
    return String(a.abertura).localeCompare(String(b.abertura));
  });
  let restante = -delta;
  const reducoes = [];
  for (const p of ordenadas) {
    if (restante <= TOLERANCIA_QTD) break;
    const retirada = Math.min(restante, p.quantidade);
    const novaQtd = arredondarQtd(p.quantidade - retirada);
    reducoes.push({ id: p.id, quantidade: novaQtd, fechar: novaQtd <= TOLERANCIA_QTD });
    restante = arredondarQtd(restante - retirada);
  }
  return { nova: null, reducoes };
}

// ------------------------------------------------------------- persistência

/**
 * Abre uma posição nova e a persiste. `origem`: 'bot' | 'externa' | 'manual'.
 *
 * `stop_loss`/`stop_loss_motivo` (V6.6): só posições de origem 'bot' nascem
 * com stop — a IA o define na hora da compra (validado e, se preciso,
 * truncado pelo Motor ANTES de chegar aqui, regrasEngine.validarStopLossCompra).
 * Posições sem stop (externa/manual, ou 'bot' de antes da V6.6) seguem só na
 * regra clássica: nunca vender no prejuízo.
 */
export async function abrirPosicao({
  plataforma,
  ativo,
  modo,
  origem,
  quantidade,
  preco_compra,
  valor = null,
  taxa_compra = null,
  percentual_ia = null,
  operacao_compra_id = null,
  abertura = null,
  sufixoId = '',
  stop_loss = null,
  stop_loss_motivo = null,
  stop_loss_trailing_percentual = null,
}) {
  const horario = abertura ?? timestampISO();
  const posicao = {
    id: gerarIdPosicao(new Date(horario), sufixoId),
    plataforma,
    ativo,
    modo,
    // INVARIANTE (V5_2_Plan.MD §4.1): `aberta_modo` = modo enquanto a posição
    // não está FECHADA e null ao fechar — é a chave da query do caminho
    // quente (posições fechadas nunca mais são lidas). Toda escrita que FECHA
    // uma posição DEVE zerá-lo; esquecer mantém a posição sendo oferecida à IA.
    aberta_modo: modo,
    origem,
    status: 'ABERTA',
    quantidade: arredondarQtd(quantidade),
    preco_compra: arredondarValor(preco_compra),
    valor,
    taxa_compra,
    percentual_ia,
    abertura: horario,
    operacao_compra_id,
    lucro_se_vender_agora: null,
    // Stop-loss por posição (V6.6): chão definido pela IA na compra, ajustável
    // só para cima (definirStopLoss). null = posição sem proteção de stop —
    // continua só na regra "nunca vender no prejuízo".
    stop_loss: numeroOuNull(stop_loss),
    // O chão DECLARADO na entrada, congelado: `stop_loss` sobe com o trailing e
    // no fechamento já não diz qual risco foi assumido ao abrir a posição. Sem
    // este campo não dá para medir risco:retorno depois (relatorioDecisoes).
    stop_loss_inicial: numeroOuNull(stop_loss),
    stop_loss_motivo: stop_loss_motivo || null,
    stop_loss_atualizado_em: stop_loss != null ? horario : null,
    // Distância do trailing automático do Motor NESTA posição, declarada pela
    // IA na compra (calibrada pela volatilidade do ativo). null = usa a config
    // do ativo e, na falta dela, o padrão do Motor.
    stop_loss_trailing_percentual: numeroOuNull(stop_loss_trailing_percentual),
    // PICO observado enquanto a posição esteve aberta (V8.5), atualizado a cada
    // ciclo pelo Motor. Sem ele não dá para medir a saída PADRÃO do sistema (o
    // chão que sobe, §10.2.1): o lote fechado guarda quanto rendeu, e nunca
    // quanto CHEGOU A RENDER — sem os dois lados a pergunta "o trailing devolve
    // lucro demais?" não tem resposta, por mais lotes que se acumule.
    // Nasce no preço de compra (nunca null): posição que só caiu tem pico = 0%
    // de avanço, que é a informação certa, não a ausência dela.
    preco_maximo: arredondarValor(preco_compra),
    preco_maximo_em: horario,
    // TRAVA DE LUCRO (V8.11, §10.8): o SEGUNDO chão, estreito, que só existe
    // acima do breakeven do lote. Nasce null e é armado pelo Motor quando o
    // pico passa do gatilho. Separado do `stop_loss` de propósito: aquele é
    // largo (a folga da §10.7) porque protege do prejuízo e precisa aguentar o
    // ruído do dia; este é estreito porque realiza lucro, e um chão largo
    // demais para isso simplesmente nunca dispara — foi o que os 23 lotes
    // fechados até 2026-08-05 mostraram (topo mediano de +1,09% contra os
    // +5,3% que a folga exigia).
    trava_lucro: null,
    trava_lucro_em: null,
    fechamento: null,
    preco_venda: null,
    taxa_venda: null,
    lucro_liquido: null,
    operacao_venda_id: null,
    // Quem fechou a posição (V6.6): 'lucro' (venda normal aprovada pela IA +
    // Motor), 'stop_loss' (Motor vendeu no prejuízo/chão, sem consultar a IA)
    // ou 'manual' (dono registrou a venda). null enquanto aberta.
    fechada_por: null,
    atualizada_em: timestampISO(),
  };
  await registrarPosicaoAtivo(plataforma, ativo, posicao);
  log.info(`posição ${posicao.id} aberta (${origem}, ${modo})`, {
    plataforma,
    ativo,
    quantidade: posicao.quantidade,
    preco_compra: posicao.preco_compra,
    stop_loss: posicao.stop_loss,
  });
  return posicao;
}

const numeroOuNull = (v) => (Number.isFinite(v) ? v : null);

/**
 * Posições não fechadas do ativo no modo, mais antigas primeiro. A query usa
 * `aberta_modo` (só docs abertos saem do Firestore — V5_2_Plan.MD §4.1); o
 * filtro por status permanece como cinto de segurança.
 */
export async function listarPosicoesAbertas(plataforma, ativo, modo) {
  const abertas = await obterPosicoesAbertasAtivo(plataforma, ativo, modo);
  return abertas
    .filter((p) => p.status !== 'FECHADA')
    .sort((a, b) => String(a.abertura).localeCompare(String(b.abertura)));
}

/**
 * Registra um PICO novo de preço numa posição aberta (V8.5).
 *
 * Só persiste; quem decide se o pico de fato subiu é o Motor
 * (`regrasEngine.avaliarPicoPosicoes`), pelo mesmo motivo do stop-loss: a regra
 * fica num módulo puro e testável, e a persistência não julga nada.
 */
export async function registrarPico(plataforma, ativo, id, { preco, horario = null }) {
  await atualizarPosicaoAtivo(plataforma, ativo, id, {
    preco_maximo: arredondarValor(preco),
    preco_maximo_em: horario ?? timestampISO(),
    atualizada_em: timestampISO(),
  });
}

/**
 * Arma (ou eleva) a TRAVA DE LUCRO de uma posição aberta (V8.11, §10.8).
 *
 * Só persiste: quem decide se a trava subiu é o Motor
 * (`regrasEngine.avaliarTravaLucro`), pelo mesmo motivo do stop-loss e do pico
 * — a regra fica num módulo puro e testável, e a persistência não julga nada.
 */
export async function definirTravaLucro(plataforma, ativo, id, { trava_lucro, horario = null }) {
  await atualizarPosicaoAtivo(plataforma, ativo, id, {
    trava_lucro: arredondarValor(trava_lucro),
    trava_lucro_em: horario ?? timestampISO(),
    atualizada_em: timestampISO(),
  });
}

/** Marca um status pontual (ex.: VENDA durante a execução real). */
export async function marcarStatus(plataforma, ativo, id, status) {
  await atualizarPosicaoAtivo(plataforma, ativo, id, { status, atualizada_em: timestampISO() });
}

/**
 * Ajusta o stop-loss de uma posição aberta (V6.6).
 *
 * REGRA DETERMINÍSTICA: o chão só SOBE. Quem valida a direção é o Motor
 * (regrasEngine.validarAjustesStopLoss) — esta função apenas persiste o que já
 * foi aprovado. Trailing stop protege lucro conforme o preço sobe; permitir
 * baixar deixaria a IA adiar indefinidamente uma perda afrouxando o limite,
 * que é exatamente o viés que o stop existe para combater.
 */
export async function definirStopLoss(plataforma, ativo, id, { stop_loss, motivo = null, horario = null }) {
  const quando = horario ?? timestampISO();
  await atualizarPosicaoAtivo(plataforma, ativo, id, {
    stop_loss: arredondarValor(stop_loss),
    stop_loss_motivo: motivo || null,
    stop_loss_atualizado_em: quando,
    atualizada_em: timestampISO(),
  });
  log.info(`stop-loss da posição ${id} definido em ${arredondarValor(stop_loss)}`, {
    plataforma,
    ativo,
    motivo,
  });
}

/**
 * Marca (ou limpa) que o stop desta posição JÁ virou recomendação pendente —
 * só usado em plataforma ASSISTIDA (V6.6), onde o bot não executa a ordem.
 *
 * Sem isso, uma posição abaixo do chão geraria uma recomendação nova a cada
 * ciclo enquanto o dono não agisse, inflando a subcoleção `operacoes`
 * (CLAUDE.md §16: nada pode crescer sem limite). Recomenda-se UMA vez por
 * episódio: o flag é limpo quando o preço volta acima do chão.
 */
export async function marcarStopRecomendado(plataforma, ativo, id, recomendadoEm) {
  await atualizarPosicaoAtivo(plataforma, ativo, id, {
    stop_recomendado_em: recomendadoEm,
    atualizada_em: timestampISO(),
  });
}

/**
 * Mesmo papel do anterior, para a TRAVA DE LUCRO (V8.11): em plataforma
 * assistida o bot só RECOMENDA, e sem esta marca ele repetiria a mesma
 * recomendação de realizar lucro a cada ciclo enquanto o dono não agisse.
 * Campo separado do stop de propósito — são dois episódios independentes, e o
 * mesmo lote pode estar em um sem estar no outro.
 */
export async function marcarTravaRecomendada(plataforma, ativo, id, recomendadaEm) {
  await atualizarPosicaoAtivo(plataforma, ativo, id, {
    trava_recomendada_em: recomendadaEm,
    atualizada_em: timestampISO(),
  });
}

/**
 * Fecha uma posição vendida, registrando o resultado realizado.
 * `fechada_por` (V6.6): 'lucro' | 'stop_loss' | 'manual' | 'externa' — deixa
 * explícito no banco QUEM mandou vender, para filtrar depois as vendas do
 * Motor (análise do agente semanal).
 */
export async function fecharPosicao(
  plataforma,
  ativo,
  id,
  { preco_venda, taxa_venda = null, lucro_liquido, operacao_venda_id = null, fechada_por = null },
) {
  await atualizarPosicaoAtivo(plataforma, ativo, id, {
    status: 'FECHADA',
    aberta_modo: null, // sai da query do caminho quente (V5_2_Plan.MD §4.1)
    fechamento: timestampISO(),
    preco_venda: arredondarValor(preco_venda),
    taxa_venda,
    lucro_liquido: lucro_liquido === null ? null : arredondarValor(lucro_liquido),
    operacao_venda_id,
    fechada_por,
    atualizada_em: timestampISO(),
  });
}

/**
 * Ciclo de vida: reavalia cada posição vendável ao preço atual —
 * lucro líquido projetado positivo → LUCRO; senão → MONITORANDO. Persiste o
 * lucro projetado (transparência: dashboard e histórico mostram o número que
 * fundamentou a decisão). Devolve as posições já atualizadas.
 */
export async function atualizarCicloDeVida(plataforma, ativo, posicoes, precoAtual, config) {
  const atualizadas = [];
  for (const p of posicoes) {
    if (!STATUS_VENDAVEIS.has(p.status)) {
      atualizadas.push(p);
      continue;
    }
    const lucro = arredondarValor(lucroDaPosicao(p, precoAtual, config));
    const status = lucro > 0 ? 'LUCRO' : 'MONITORANDO';
    if (status !== p.status || lucro !== p.lucro_se_vender_agora) {
      await atualizarPosicaoAtivo(plataforma, ativo, p.id, {
        status,
        lucro_se_vender_agora: lucro,
        atualizada_em: timestampISO(),
      });
    }
    atualizadas.push({ ...p, status, lucro_se_vender_agora: lucro });
  }
  return atualizadas;
}

/**
 * Espelha no livro de posições o ativo que entrou/saiu POR FORA do bot
 * (compra manual na plataforma, depósito, saque). MELHOR ESFORÇO: falha aqui
 * não derruba a análise. Devolve a lista de posições abertas já reconciliada.
 */
export async function sincronizarPosicoesComSaldo({ plataforma, ativo, modo, saldo, preco_atual }) {
  let posicoes = await listarPosicoesAbertas(plataforma, ativo, modo);
  try {
    const { nova, reducoes } = reconciliarComSaldo(posicoes, saldo, preco_atual);
    if (nova) {
      const aberta = await abrirPosicao({
        plataforma,
        ativo,
        modo,
        origem: 'externa',
        quantidade: nova.quantidade,
        preco_compra: nova.preco_compra,
        sufixoId: 'ext',
      });
      log.info(`${ativo} externo detectado (compra manual/depósito) — posição externa criada`, {
        quantidade: nova.quantidade,
      });
      posicoes = [...posicoes, aberta];
    }
    for (const r of reducoes) {
      if (r.fechar) {
        await fecharPosicao(plataforma, ativo, r.id, { preco_venda: preco_atual, lucro_liquido: null, fechada_por: 'externa' });
      } else {
        await atualizarPosicaoAtivo(plataforma, ativo, r.id, { quantidade: r.quantidade, atualizada_em: timestampISO() });
      }
      posicoes = posicoes
        .map((p) => (p.id === r.id ? { ...p, quantidade: r.quantidade, status: r.fechar ? 'FECHADA' : p.status } : p))
        .filter((p) => p.status !== 'FECHADA');
      log.aviso(`saída externa de ${ativo} abatida da posição ${r.id}`, r);
    }
  } catch (e) {
    log.aviso(`não foi possível reconciliar posições de ${ativo} com o saldo — seguindo com as atuais`, e);
  }
  return posicoes;
}

/** Soma das quantidades das posições (para sanidade contra o saldo). */
export function somaQuantidades(posicoes) {
  return arredondarQtd(posicoes.reduce((s, p) => s + p.quantidade, 0));
}

/** Preço médio ponderado das posições abertas (informativo — dashboard). */
export function precoMedioDasPosicoes(posicoes) {
  const abertas = posicoes.filter((p) => p.status !== 'FECHADA');
  const qtd = somaQuantidades(abertas);
  if (qtd <= 0) return null;
  const custo = abertas.reduce((s, p) => s + p.quantidade * p.preco_compra, 0);
  return custo / qtd;
}
