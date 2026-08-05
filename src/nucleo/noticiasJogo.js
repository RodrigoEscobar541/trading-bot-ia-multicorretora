// noticiasJogo.js — o "ouvinte" das atualizações do jogo (ROADMAP prioridade 4,
// fase 2). Hoje só a Steam/CS2 tem isso, mas o núcleo não sabe disso: o
// orquestrador chama quando o conector TEM `noticias()`.
//
// Por que existe: num mercado de skin, notícia do jogo É o fundamento. Case
// nova, operação nova, mudança de drop ou nerf de arma mexem no preço mais que
// qualquer indicador técnico — e são o único "dado de mercado" decente que este
// mercado tem, já que ele não fornece candle nenhum.
//
// O que esta fase entrega, sozinha: o aviso no Telegram quando sai atualização.
// A parte de LEVAR a nota para o prompt da IA (e forçar a análise dos itens
// marcados) é a fase 3 — mas o documento que ela vai ler já nasce aqui, e é por
// isso que a nota é gravada limpa e cortada desde já.
//
// Custo, pelas mesmas três réguas do inventário:
//  1. UMA chamada HTTP por rodada, no intervalo que o dono configurou.
//  2. Relógio em MEMÓRIA: o tick de 1 min não lê Firestore nenhum.
//  3. Escrita só quando há novidade — nota repetida não gera escrita.

import { obterNoticiasPlataforma, salvarNoticiasPlataforma } from '../firebase/firebaseClient.js';
import { intervalosDaPlataforma } from '../conectores/steam/conectorSTEAM.js';
import { notificarNoticiaJogo } from '../notificacoes/telegram.js';
import { log } from '../utils/logger.js';

// Quantos anúncios ficam guardados. O suficiente para a tela mostrar o
// histórico recente e para a fase 3 escolher o que mandar à IA.
export const NOTICIAS_GUARDADAS = 10;
// Quantos `gid` ficam na memória do "já vi". Maior que a lista guardada de
// propósito: um anúncio que sai da lista não pode voltar a ser "novidade".
export const GIDS_LEMBRADOS = 60;

const ultimaConsulta = new Map(); // plataformaId -> epoch ms

/** Só para testes: esquece o relógio em memória. */
export function esquecerEstadoNoticias() {
  ultimaConsulta.clear();
}

/** Venceu o intervalo? Função PURA (mesma régua do inventário). */
export function deveConsultar(ultimoMs, intervaloMinutos, agoraMs = Date.now()) {
  if (!Number.isFinite(ultimoMs)) return true;
  const intervalo = Math.max(1, Number(intervaloMinutos) || 0) * 60_000;
  return agoraMs - ultimoMs >= intervalo;
}

/**
 * Quais notícias são NOVAS. Função PURA — o coração da fase, e por isso a mais
 * testada.
 *
 * A régua é o `gid` (id estável do anúncio), nunca a data nem o título: a Valve
 * edita notas publicadas (a data muda) e o título é sempre "Counter-Strike 2
 * Update". Comparar por data ou título daria aviso repetido ou aviso nenhum.
 *
 * PRIMEIRA EXECUÇÃO devolve lista vazia de propósito: sem memória do que já
 * houve, tudo pareceria novo e o dono receberia 10 avisos de anúncios velhos
 * logo depois de configurar. O primeiro ciclo só APRENDE o que existe.
 */
export function noticiasNovas(itens, gidsVistos = [], primeiraVez = false) {
  const lista = Array.isArray(itens) ? itens : [];
  if (primeiraVez) return [];
  const vistos = new Set(gidsVistos ?? []);
  return lista.filter((n) => n?.gid && !vistos.has(n.gid));
}

/** Lista de gids atualizada, limitada e sem repetição (mais recentes na frente). */
export function gidsAtualizados(itens, gidsVistos = []) {
  const novos = (Array.isArray(itens) ? itens : []).map((n) => n.gid).filter(Boolean);
  return [...new Set([...novos, ...(gidsVistos ?? [])])].slice(0, GIDS_LEMBRADOS);
}

/**
 * Procura atualização do jogo e avisa no Telegram se houver.
 * Devolve `{ consultado: false }` quando ainda não é hora — caminho comum.
 *
 * NUNCA lança: notícia é informação, não decisão.
 */
export async function verificarNoticias({
  plataforma,
  conector,
  agoraMs = Date.now(),
  forcar = false,
  configTelegram = null,
} = {}) {
  const plataformaId = plataforma?.id ?? 'STEAM';
  const { noticias_minutos } = intervalosDaPlataforma(plataforma);
  if (!forcar && !deveConsultar(ultimaConsulta.get(plataformaId), noticias_minutos, agoraMs)) {
    return { consultado: false };
  }
  ultimaConsulta.set(plataformaId, agoraMs);

  try {
    const itens = await conector.noticias({ quantidade: NOTICIAS_GUARDADAS });
    if (itens.length === 0) return { consultado: true, novas: [] };

    const anterior = await obterNoticiasPlataforma(plataformaId);
    // Documento sem nenhum gid = este bot nunca viu este feed.
    const primeiraVez = (anterior.gids_vistos ?? []).length === 0;
    const novas = noticiasNovas(itens, anterior.gids_vistos, primeiraVez);

    // Sem novidade e sem primeira vez: nada muda no banco. É o caso comum, e
    // gravar aqui seria uma escrita por rodada para dizer "continua igual".
    if (novas.length === 0 && !primeiraVez) return { consultado: true, novas: [] };

    await salvarNoticiasPlataforma(plataformaId, {
      itens: itens.slice(0, NOTICIAS_GUARDADAS),
      gids_vistos: gidsAtualizados(itens, anterior.gids_vistos),
      ultima_novidade_em: novas.length > 0 ? new Date(agoraMs).toISOString() : anterior.ultima_novidade_em,
    });

    if (primeiraVez) {
      log.info(`notícias de ${plataformaId}: ${itens.length} anúncios conhecidos (primeira leitura — sem avisos)`);
      return { consultado: true, novas: [] };
    }

    // Da mais antiga para a mais nova: se saíram duas de uma vez, o dono lê na
    // ordem em que aconteceram.
    for (const noticia of [...novas].reverse()) {
      await notificarNoticiaJogo({ noticia, config: configTelegram });
    }
    log.info(`notícias de ${plataformaId}: ${novas.length} nova(s) — "${novas[0].titulo}"`);
    return { consultado: true, novas };
  } catch (e) {
    log.aviso(`falha ao procurar atualizações do jogo (${plataformaId})`, e);
    return { consultado: false, erro: e.message ?? String(e) };
  }
}
