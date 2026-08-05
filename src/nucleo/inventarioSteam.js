// inventarioSteam.js — retrato do INVENTÁRIO de uma plataforma com itens
// (hoje só a Steam), publicado para a dashboard (ROADMAP prioridade 4, fase 1).
//
// Por que existe: os endpoints da Steam não liberam CORS, então o navegador
// não consegue ler o inventário direto — uma chamada da dashboard falharia.
// Quem lê é o BOT; a tela só desenha o que já está no Firestore.
//
// O núcleo continua sem código específico de plataforma: o orquestrador chama
// isto quando o conector tem o método `inventario()`, não quando a plataforma
// se chama STEAM.
//
// TRÊS custos governam o desenho deste módulo:
//  1. Limite da Steam (~20 chamadas/min) e UMA chamada de preço por item — não
//     existe lote. Daí a pausa entre chamadas e o LOTE por rodada.
//  2. O tick do orquestrador é serial: uma varredura longa atrasaria os ciclos
//     dos outros ativos. Daí o teto de itens por rodada (o restante entra na
//     rodada seguinte, em rodízio).
//  3. Leitura do Firestore (invariante V5.2): o relógio da última atualização
//     vive em MEMÓRIA, então o tick de 1 min não lê nada; o documento só é
//     tocado quando há retrato novo para gravar.

import {
  obterInventarioPlataforma,
  salvarInventarioPlataforma,
  obterAlertasPlataforma,
  salvarEstadoAlertas,
} from '../firebase/firebaseClient.js';
import { dispararAlertas } from './alertasPreco.js';
import { intervalosDaPlataforma } from '../conectores/steam/conectorSTEAM.js';
import { log } from '../utils/logger.js';

// Quantos itens têm o preço revalidado por rodada. 25 × 3,5 s ≈ 90 s de fila
// no pior caso — atraso aceitável uma vez por hora, e o rodízio garante que
// todos sejam cobertos.
export const LOTE_PRECOS_PADRAO = 25;

// Relógio e cursor do rodízio, POR PLATAFORMA, em memória. Reiniciar o bot
// simplesmente refaz o retrato na primeira rodada — o custo é uma varredura.
const ultimaAtualizacao = new Map();
const cursorRodizio = new Map();

/** Só para testes: esquece o relógio/cursor em memória. */
export function esquecerEstadoInventario() {
  ultimaAtualizacao.clear();
  cursorRodizio.clear();
}

/**
 * Venceu o intervalo? Função PURA. `ultimoMs` null/ausente (bot recém-iniciado)
 * = SIM: o retrato precisa existir antes de a tela ter o que mostrar.
 */
export function deveAtualizar(ultimoMs, intervaloMinutos, agoraMs = Date.now()) {
  if (!Number.isFinite(ultimoMs)) return true;
  const intervalo = Math.max(1, Number(intervaloMinutos) || 0) * 60_000;
  return agoraMs - ultimoMs >= intervalo;
}

/**
 * Quais itens têm o preço revalidado nesta rodada, em rodízio a partir do
 * cursor. Função PURA (o cursor entra e sai como valor). Devolve também o
 * cursor seguinte, que dá a volta na lista.
 *
 * Itens NÃO negociáveis ficam de fora: não têm preço no mercado, e gastar uma
 * chamada com eles atrasaria os que têm.
 */
export function fatiaDoRodizio(itens, cursor = 0, tamanho = LOTE_PRECOS_PADRAO) {
  const elegiveis = (Array.isArray(itens) ? itens : []).filter((i) => i.negociavel !== false);
  if (elegiveis.length === 0) return { nomes: [], proximoCursor: 0 };
  const inicio = Number.isFinite(cursor) ? ((cursor % elegiveis.length) + elegiveis.length) % elegiveis.length : 0;
  const nomes = [];
  for (let i = 0; i < Math.min(tamanho, elegiveis.length); i++) {
    nomes.push(elegiveis[(inicio + i) % elegiveis.length].market_hash_name);
  }
  return { nomes, proximoCursor: (inicio + nomes.length) % elegiveis.length };
}

/**
 * Junta o inventário com os preços coletados e com o retrato ANTERIOR.
 * Função PURA — é aqui que mora a regra, e é o que os testes cobrem.
 *
 * O preço anterior é preservado quando o item não entrou na fatia desta
 * rodada: com rodízio, a maioria dos itens não é reconsultada, e apagar o
 * preço deles faria a tela piscar entre "R$ 12,34" e "—" a cada rodada.
 * `preco_em` diz de quando é cada preço, para o valor velho nunca se passar
 * por fresco.
 */
export function mesclarPrecos(itens, precos = {}, anteriores = [], agoraISO = new Date().toISOString()) {
  const antes = new Map((Array.isArray(anteriores) ? anteriores : []).map((i) => [i.market_hash_name, i]));
  return (Array.isArray(itens) ? itens : []).map((item) => {
    const novo = precos[item.market_hash_name];
    const velho = antes.get(item.market_hash_name);
    const preco = novo ? novo.ultimo : (velho?.preco ?? null);
    const preco_em = novo ? agoraISO : (velho?.preco_em ?? null);
    return {
      ...item,
      preco,
      preco_em,
      volume_24h: novo ? novo.volume : (velho?.volume_24h ?? null),
      valor_total: preco === null ? null : Number((preco * item.quantidade).toFixed(2)),
    };
    // Sem campo "analisado" aqui de propósito: quem responde isso é o ATIVO
    // (existe e está ligado?), e a dashboard já tem essa lista. Um espelho
    // neste retrato seria um segundo lugar para a mesma verdade — exatamente o
    // tipo de dado que envelhece e passa a mentir (lição da V7.0/V7.3).
  });
}

/** Soma do que tem preço. Itens sem preço ficam de fora — nunca contam zero. */
export function totalDoInventario(itens) {
  return (Array.isArray(itens) ? itens : [])
    .filter((i) => Number.isFinite(i.valor_total))
    .reduce((soma, i) => soma + i.valor_total, 0);
}

/**
 * Atualiza o retrato do inventário da plataforma, se o intervalo dela venceu.
 * Devolve `{ atualizado: false }` quando ainda não é hora — é o caminho comum
 * e não custa nada.
 *
 * NUNCA lança: inventário é informação, não decisão. Falha vira aviso no log e
 * o retrato anterior continua na tela, com a data dele.
 */
export async function atualizarInventario({
  plataforma,
  conector,
  agoraMs = Date.now(),
  forcar = false,
  lote = LOTE_PRECOS_PADRAO,
  anteriores = null,
  configTelegram = null,
} = {}) {
  const plataformaId = plataforma?.id ?? 'STEAM';
  const { precos_minutos } = intervalosDaPlataforma(plataforma);
  if (!forcar && !deveAtualizar(ultimaAtualizacao.get(plataformaId), precos_minutos, agoraMs)) {
    return { atualizado: false };
  }
  // Marca ANTES de trabalhar: se a varredura falhar no meio, a próxima
  // tentativa espera o intervalo em vez de repetir a cada tick contra uma
  // Steam que já demonstrou estar fora do ar.
  ultimaAtualizacao.set(plataformaId, agoraMs);

  // UMA leitura por atualização (não por tick): é dela que vêm os preços dos
  // itens que não entraram na fatia desta rodada e a marca do check.
  let anterior = anteriores;
  if (anterior === null) {
    try {
      anterior = (await obterInventarioPlataforma(plataformaId)).itens;
    } catch {
      anterior = [];
    }
  }

  try {
    const itens = await conector.inventario();
    const { nomes, proximoCursor } = fatiaDoRodizio(itens, cursorRodizio.get(plataformaId) ?? 0, lote);
    cursorRodizio.set(plataformaId, proximoCursor);

    const precos = nomes.length > 0 ? await conector.precos(nomes) : {};
    const comPreco = mesclarPrecos(itens, precos, anterior, new Date(agoraMs).toISOString());
    await salvarInventarioPlataforma(plataformaId, { itens: comPreco });

    // Alertas de preço-alvo: pegam carona nos preços que ACABARAM de chegar —
    // nenhuma consulta nova à Steam. Uma leitura por atualização (não por tick).
    // Falhar aqui não pode desfazer o retrato que já foi gravado, por isso vem
    // depois dele e tem try próprio dentro de `dispararAlertas`.
    const alertas = await obterAlertasPlataforma(plataformaId);
    const r = await dispararAlertas({
      itens: comPreco,
      alvos: alertas.itens,
      estado: alertas.estado,
      configTelegram,
      moeda: plataforma?.moeda ?? 'BRLS',
    });
    // Escreve quando o ESTADO mudou, não quando houve disparo: o REARME (preço
    // voltando acima do alvo) também precisa ser gravado, senão a travessia
    // seguinte não avisaria — o banco continuaria achando que já avisou.
    // Item parado abaixo do alvo não muda nada e não gera escrita.
    if (JSON.stringify(r.estado) !== JSON.stringify(alertas.estado ?? {})) {
      await salvarEstadoAlertas(plataformaId, r.estado);
    }
    log.info(
      `inventário ${plataformaId}: ${comPreco.length} itens, ${Object.keys(precos).length} preços atualizados`,
    );
    return { atualizado: true, itens: comPreco, total: totalDoInventario(comPreco) };
  } catch (e) {
    log.aviso(`falha ao atualizar o inventário de ${plataformaId} — o retrato anterior continua valendo`, e);
    try {
      await salvarInventarioPlataforma(plataformaId, { itens: anterior ?? [], erro: e.message ?? String(e) });
    } catch {
      /* nem o aviso pôde ser gravado: melhor esforço, o loop segue */
    }
    return { atualizado: false, erro: e.message ?? String(e) };
  }
}
