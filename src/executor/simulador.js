// simulador.js — execução FICTÍCIA de ordens (Modo Simulação, CLAUDE.md §11).
//
// A simulação só muda o passo final do fluxo: em vez de enviar a ordem à
// plataforma, atualiza uma carteira virtual persistida no estado da PLATAFORMA
// (V2_Plan.MD §B.3: o depósito real é um só, então o caixa virtual é um por
// plataforma — um saldo na moeda + um saldo por ativo). IA e Motor de Regras
// jamais sabem qual modo está ativo (regras.md §1.3/§1.8).
//
// Patrimônio inicial (regras.md §7): SEMPRE copiado dos saldos reais da
// plataforma no momento em que a simulação inicia — nunca um valor fixo.
// O custo-base de ativos pré-existentes é responsabilidade do livro de
// POSIÇÕES (posição externa ao preço de mercado da detecção — conservador);
// a carteira virtual só acompanha quantidades e caixa.

import { obterEstadoPlataforma, salvarEstadoPlataforma } from '../firebase/firebaseClient.js';
import { calcularLucroLiquidoVenda } from '../regras/regrasEngine.js';
import { log } from '../utils/logger.js';

const arredondarQtd = (v) => Math.round(v * 1e8) / 1e8;
const arredondarValor = (v) => Math.round(v * 100) / 100;

/**
 * Garante que a carteira virtual da plataforma existe; na primeira vez, copia
 * os saldos reais (exige credenciais configuradas — regra imutável, sem
 * fallback de saldo fixo). Devolve { saldo_moeda, saldos, inicializada_em }.
 * `estadoConhecido` (opcional, V5_2_Plan.MD §3.4): estado da plataforma já
 * lido por quem chamou — evita reler o mesmo doc; precisa ser DESTE ciclo,
 * de antes de qualquer ordem.
 */
export async function garantirCarteiraVirtual(plataformaId, conector, estadoConhecido = null) {
  const estado = estadoConhecido ?? (await obterEstadoPlataforma(plataformaId));
  if (estado.carteira_virtual) return estado.carteira_virtual;

  const reais = await conector.saldos();
  const agora = new Date().toISOString();
  const carteira = {
    saldo_moeda: reais.saldo_moeda,
    saldos: { ...reais.saldos },
    inicializada_em: agora,
  };
  await salvarEstadoPlataforma(plataformaId, {
    carteira_virtual: carteira,
    // Foto dos saldos reais — referência do detector de depósitos/saques.
    sincronizacao_saldos_reais: { saldo_moeda: reais.saldo_moeda, saldos: { ...reais.saldos }, em: agora },
  });
  log.info(`carteira virtual da plataforma ${plataformaId} inicializada com os saldos reais`, {
    saldo_moeda: reais.saldo_moeda,
    saldos: reais.saldos,
  });
  return carteira;
}

/**
 * Aplica à carteira virtual deltas EXTERNOS detectados na conta real
 * (depósito/saque na moeda ou em qualquer ativo). Função pura — recebe
 * cópias, devolve a carteira ajustada.
 *
 * Regras (documentadas):
 *   - Moeda: soma/subtrai direto; saque maior que o saldo virtual trava em 0.
 *   - Ativo: idem por símbolo; o custo-base de entradas externas é tratado
 *     pelo livro de posições (posição externa), não aqui.
 */
export function aplicarDeltaExterno(carteira, { deltaMoeda = 0, deltasAtivos = {} }) {
  const ajustada = { ...carteira, saldos: { ...(carteira.saldos ?? {}) } };
  if (deltaMoeda !== 0) {
    ajustada.saldo_moeda = arredondarValor(Math.max(0, ajustada.saldo_moeda + deltaMoeda));
  }
  for (const [simbolo, delta] of Object.entries(deltasAtivos)) {
    if (!delta) continue;
    const atual = ajustada.saldos[simbolo] ?? 0;
    ajustada.saldos[simbolo] = arredondarQtd(Math.max(0, atual + delta));
  }
  return ajustada;
}

// Mudanças menores que isso são ruído de arredondamento, não depósito/saque.
const MINIMO_DELTA_MOEDA = 0.01;
const MINIMO_DELTA_QTD = 0.00000001;

/**
 * Detecta depósitos/saques na conta REAL e espelha o delta na carteira
 * virtual (a simulação continua paralela: só o que veio de fora entra).
 * Chamada a cada análise em modo simulação. MELHOR ESFORÇO: falha aqui não
 * pode derrubar a análise — loga aviso e devolve a carteira como está.
 * `estadoConhecido` como em garantirCarteiraVirtual (V5_2_Plan.MD §3.4);
 * um estado de ANTES da semeadura devolve null e quem chamou usa a carteira
 * recém-semeada — mesmo resultado da releitura.
 */
export async function sincronizarComSaldosReais(plataformaId, conector, estadoConhecido = null) {
  const estado = estadoConhecido ?? (await obterEstadoPlataforma(plataformaId));
  const carteira = estado.carteira_virtual;
  if (!carteira) return null; // ainda não semeada — garantirCarteiraVirtual cuida

  try {
    const atual = await conector.saldos();
    const agora = new Date().toISOString();

    const referencia = estado.sincronizacao_saldos_reais;
    if (!referencia) {
      // Carteiras antigas (antes deste recurso): estabelece a referência.
      await salvarEstadoPlataforma(plataformaId, {
        sincronizacao_saldos_reais: { saldo_moeda: atual.saldo_moeda, saldos: { ...atual.saldos }, em: agora },
      });
      return carteira;
    }

    const deltaMoeda = atual.saldo_moeda - (referencia.saldo_moeda ?? 0);
    const deltasAtivos = {};
    const simbolos = new Set([...Object.keys(atual.saldos ?? {}), ...Object.keys(referencia.saldos ?? {})]);
    for (const s of simbolos) {
      const delta = (atual.saldos?.[s] ?? 0) - (referencia.saldos?.[s] ?? 0);
      if (Math.abs(delta) >= MINIMO_DELTA_QTD) deltasAtivos[s] = delta;
    }
    if (Math.abs(deltaMoeda) < MINIMO_DELTA_MOEDA && Object.keys(deltasAtivos).length === 0) {
      return carteira; // nada mudou na conta real
    }

    const ajustada = aplicarDeltaExterno(carteira, { deltaMoeda, deltasAtivos });
    await salvarEstadoPlataforma(plataformaId, {
      carteira_virtual: ajustada,
      sincronizacao_saldos_reais: { saldo_moeda: atual.saldo_moeda, saldos: { ...atual.saldos }, em: agora },
    });
    log.info('movimentação externa detectada na conta real — espelhada na carteira virtual', {
      plataforma: plataformaId,
      delta_moeda: arredondarValor(deltaMoeda),
      deltas_ativos: deltasAtivos,
    });
    return ajustada;
  } catch (e) {
    log.aviso('não foi possível sincronizar saldos reais — seguindo com a carteira virtual atual', e);
    return carteira;
  }
}

/**
 * Executa uma ordem aprovada pelo Motor de Regras contra a carteira virtual,
 * preenchendo ao preço de execução informado. Persiste a carteira e devolve o
 * "fill" no mesmo formato que a execução real:
 *   { quantidade, valor, preco, taxa, lucro_liquido|null }
 */
export async function executarOrdemSimulada({ plataformaId, ativoId, ordem, config }) {
  const estado = await obterEstadoPlataforma(plataformaId);
  const carteira = estado.carteira_virtual;
  if (!carteira) {
    throw new Error('carteira virtual não inicializada — garantirCarteiraVirtual() antes');
  }
  carteira.saldos ??= {};

  const preco = ordem.preco_execucao;

  if (ordem.tipo === 'COMPRA') {
    const valor = ordem.valor;
    if (valor > carteira.saldo_moeda) {
      throw new Error(`simulação: valor ${valor} excede saldo virtual ${carteira.saldo_moeda}`);
    }
    const taxa = valor * (config.taxa_compra_percentual / 100);
    const qtd = arredondarQtd((valor - taxa) / preco);

    carteira.saldo_moeda = arredondarValor(carteira.saldo_moeda - valor);
    carteira.saldos[ativoId] = arredondarQtd((carteira.saldos[ativoId] ?? 0) + qtd);

    await salvarEstadoPlataforma(plataformaId, { carteira_virtual: carteira });
    return {
      quantidade: qtd,
      valor,
      preco,
      taxa: arredondarValor(taxa),
      lucro_liquido: null, // lucro só se realiza na venda
      carteira_apos: structuredClone(carteira),
    };
  }

  if (ordem.tipo === 'VENDA') {
    const qtd = ordem.quantidade;
    const saldoAtivo = carteira.saldos[ativoId] ?? 0;
    if (qtd > saldoAtivo) {
      throw new Error(`simulação: quantidade ${qtd} excede saldo virtual ${saldoAtivo} de ${ativoId}`);
    }
    const bruto = qtd * preco;
    const taxa = bruto * (config.taxa_venda_percentual / 100);

    // Venda por posições (CLAUDE.md §11.1): o lucro vem dos lotes vendidos —
    // na V2 a ordem de venda SEMPRE carrega as posições aprovadas pelo Motor.
    if (!Array.isArray(ordem.posicoes) || ordem.posicoes.length === 0) {
      throw new Error('simulação: ordem de VENDA sem posições — o Motor de Regras sempre as define na V2');
    }
    const lucro = ordem.posicoes.reduce(
      (s, p) =>
        s +
        calcularLucroLiquidoVenda({
          quantidade: p.quantidade,
          preco_venda: preco,
          preco_compra: p.preco_compra,
          taxa_compra_percentual: config.taxa_compra_percentual,
          taxa_venda_percentual: config.taxa_venda_percentual,
        }),
      0,
    );

    carteira.saldos[ativoId] = arredondarQtd(saldoAtivo - qtd);
    carteira.saldo_moeda = arredondarValor(carteira.saldo_moeda + (bruto - taxa));

    await salvarEstadoPlataforma(plataformaId, { carteira_virtual: carteira });
    return {
      quantidade: qtd,
      valor: arredondarValor(bruto - taxa),
      preco,
      taxa: arredondarValor(taxa),
      lucro_liquido: arredondarValor(lucro),
      carteira_apos: structuredClone(carteira),
    };
  }

  throw new Error(`simulação: tipo de ordem desconhecido: ${ordem.tipo}`);
}
