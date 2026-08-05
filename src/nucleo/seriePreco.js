// seriePreco.js — a série de preço que o BOT constrói sozinho, para os ativos
// cujo mercado não fornece candle (ROADMAP prioridade 4, fase 3).
//
// O caso é o mercado da Steam: ele diz quanto uma skin custa AGORA, quanto
// custou nas últimas vendas e quantas unidades venderam em 24 h — mas não tem
// histórico. O único endpoint que teria (`/market/pricehistory/`) exige o
// cookie de sessão da conta do dono, e a decisão registrada foi não usá-lo.
//
// Sem passado não há RSI, MACD nem média móvel — e, o que é pior, não há a
// pergunta mais simples de todas: "está caro ou barato em relação à semana
// passada?". Este módulo responde essa pergunta guardando um ponto por coleta.
// Começa cego e enxerga mais a cada dia; em uma semana já há o que comparar.
//
// Não é candle e não tenta ser: um ponto é (instante, preço), sem abertura,
// máxima nem mínima. Inventar OHLC a partir de amostras horárias seria fabricar
// precisão que não existe.

import { obterSeriePrecoAtivo, salvarSeriePrecoAtivo } from '../firebase/firebaseClient.js';
import { log } from '../utils/logger.js';

// Quantos pontos ficam guardados. Com coleta de hora em hora, 720 pontos são
// ~30 dias — o suficiente para as três janelas abaixo, e ainda bem dentro do
// limite de 1 MB de um documento do Firestore.
export const PONTOS_MAX = 720;

// Distância mínima entre pontos. Sem isto, um ativo com análise a cada 15 min
// gravaria 96 pontos/dia e a janela de 30 dias encolheria para 7.
export const INTERVALO_MINIMO_MS = 30 * 60_000;

/**
 * Acrescenta um ponto à série. Função PURA (recebe e devolve a lista).
 *
 * Ignora o ponto quando o anterior é recente demais — a série existe para
 * medir DIAS, e amostrar de 15 em 15 minutos só encurtaria o passado guardado.
 * Preço inválido nunca entra: um null viraria uma variação inventada.
 */
export function acrescentarPonto(pontos, { t, p }, { max = PONTOS_MAX, intervaloMinimoMs = INTERVALO_MINIMO_MS } = {}) {
  const lista = Array.isArray(pontos) ? pontos : [];
  if (!Number.isFinite(p) || p <= 0 || !t) return lista;
  const ultimo = lista[lista.length - 1];
  if (ultimo && new Date(t).getTime() - new Date(ultimo.t).getTime() < intervaloMinimoMs) return lista;
  return [...lista, { t, p: Number(p) }].slice(-max);
}

/** Ponto mais próximo (e anterior) a um instante; null se a série não alcança. */
function pontoEm(pontos, alvoMs) {
  let achado = null;
  for (const ponto of pontos) {
    if (new Date(ponto.t).getTime() <= alvoMs) achado = ponto;
    else break;
  }
  return achado;
}

const variacao = (de, para) => (de > 0 ? Math.round(((para - de) / de) * 10000) / 100 : null);

/**
 * O que a série sabe dizer HOJE. Função PURA.
 *
 * Toda janela que a série ainda não cobre volta `null` — nunca 0 e nunca a
 * variação desde o ponto mais antigo disponível. Fingir que "24 h" é na verdade
 * "3 h" seria mentir para a IA com cara de dado, e é exatamente o tipo de
 * silêncio que já cegou uma métrica neste projeto (V8.1).
 */
export function resumirSerie(pontos, agora = new Date()) {
  const lista = (Array.isArray(pontos) ? pontos : []).filter((x) => Number.isFinite(x?.p) && x?.t);
  if (lista.length === 0) {
    return { pontos: 0, desde: null, variacao_24h: null, variacao_7d: null, variacao_30d: null, maxima: null, minima: null, dias_de_historico: 0 };
  }
  const agoraMs = agora.getTime();
  const atual = lista[lista.length - 1].p;
  const inicioMs = new Date(lista[0].t).getTime();
  const dia = 24 * 60 * 60_000;

  const janela = (dias) => {
    // A janela só é respondida quando a série REALMENTE a cobre.
    if (agoraMs - inicioMs < dias * dia) return null;
    const ref = pontoEm(lista, agoraMs - dias * dia);
    return ref ? variacao(ref.p, atual) : null;
  };

  const precos = lista.map((x) => x.p);
  return {
    pontos: lista.length,
    desde: lista[0].t,
    dias_de_historico: Math.round(((agoraMs - inicioMs) / dia) * 10) / 10,
    variacao_24h: janela(1),
    variacao_7d: janela(7),
    variacao_30d: janela(30),
    maxima: Math.max(...precos),
    minima: Math.min(...precos),
  };
}

/**
 * Lê a série, acrescenta o preço de agora e devolve o resumo para o JSON da IA.
 * Grava só quando o ponto de fato entrou.
 *
 * NUNCA lança: série é medição, não decisão — falhar aqui não pode impedir uma
 * análise nem uma ordem (mesma postura do pico do lote, §10.6).
 */
export async function registrarPreco(plataformaId, ativoId, preco, agoraISO = new Date().toISOString()) {
  try {
    const doc = await obterSeriePrecoAtivo(plataformaId, ativoId);
    const pontos = acrescentarPonto(doc.pontos, { t: agoraISO, p: preco });
    if (pontos !== doc.pontos && pontos.length !== (doc.pontos?.length ?? 0)) {
      await salvarSeriePrecoAtivo(plataformaId, ativoId, pontos);
    }
    return resumirSerie(pontos, new Date(agoraISO));
  } catch (e) {
    log.aviso(`[${plataformaId}/${ativoId}] falha ao guardar o preço na série própria`, e);
    return resumirSerie([], new Date(agoraISO));
  }
}
