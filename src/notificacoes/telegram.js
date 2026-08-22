// telegram.js — ÚNICO módulo que fala com a API do Telegram (V7, parte 1).
//
// Mesma disciplina de fronteira dos conectores (só eles falam com corretoras) e
// do iaClient (só ele fala com a IA): nenhum outro módulo monta URL do Telegram.
//
// PRINCÍPIO INEGOCIÁVEL DESTE MÓDULO: **notificação nunca quebra o robô**.
// Toda função pública é best-effort e NUNCA lança — um Telegram fora do ar, um
// token errado ou um chat apagado não podem derrubar um ciclo de análise nem
// impedir uma ordem. Falhas viram log de aviso e a vida segue.
//
// Não usa IA: é tudo formatação de dados que o sistema já tem (ROADMAP V7).
//
// Configuração no doc GLOBAL `global/telegram` (escrito pela dashboard, lido
// pelo bot via CATÁLOGO cacheado — o tick de 1 min não pode ganhar leitura
// nova, invariante V5.2). Em desenvolvimento cai para o .env
// (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).

import { log, registrarSegredo } from '../utils/logger.js';
import { formatarDinheiro } from '../utils/formatador.js';

const API_BASE = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

/** Tipos de evento que a dashboard liga/desliga individualmente. */
export const EVENTOS = ['compra', 'venda', 'recomendacao', 'problema', 'relatorio', 'supervisao', 'modo_vendas', 'noticia_jogo', 'alerta_preco'];

// Avisos de PROBLEMA se repetiriam a cada ciclo (quota esgotada volta em todo
// tick até a meia-noite do Pacífico). Trava: no máximo um por chave a cada 24 h.
export const INTERVALO_ANTISPAM_MS = 24 * 60 * 60 * 1000;
const ultimoProblema = new Map(); // chave -> epoch ms

/** Zera a trava anti-spam (testes e reinício de processo). */
export function limparAntiSpam() {
  ultimoProblema.clear();
}

/**
 * Normaliza a config vinda do Firestore, com fallback para o .env.
 * Devolve null quando não há como notificar (sem token ou sem chat).
 */
export function resolverConfig(doc = null, env = process.env) {
  const token = (doc?.bot_token || env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(doc?.chat_id || env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return null;
  // `ativo` ausente = ligado: quem se deu ao trabalho de configurar quer receber.
  if (doc && doc.ativo === false) return null;
  const eventos = {};
  for (const e of EVENTOS) eventos[e] = doc?.eventos?.[e] !== false;
  return { token, chatId, eventos };
}

/** Escapa o que o parse_mode HTML do Telegram trata como marcação. */
export function escaparHTML(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Envia UMA mensagem. Não lança: devolve true/false.
 * `fetchFn` é injetável para teste (nada de rede na suíte).
 */
export async function enviarMensagem(texto, config, { fetchFn = fetch } = {}) {
  if (!config?.token || !config?.chatId) return false;
  registrarSegredo(config.token); // o logger redige o token em qualquer log
  try {
    const resposta = await fetchFn(`${API_BASE}/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: texto,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resposta.ok) {
      // A descrição do Telegram é o que resolve o problema ("chat not found",
      // "the bot can't send messages to the bot"); só o código HTTP não diz nada.
      const descricao = await lerDescricaoErro(resposta);
      registrarEnvio(false, `HTTP ${resposta.status}: ${descricao}`);
      log.aviso(`Telegram: envio recusado — HTTP ${resposta.status}: ${descricao}`);
      return false;
    }
    registrarEnvio(true);
    return true;
  } catch (e) {
    registrarEnvio(false, e.message);
    log.aviso('Telegram: falha ao enviar a notificação', e);
    return false;
  }
}

/** Extrai `description` do corpo de erro do Telegram, sem nunca lançar. */
async function lerDescricaoErro(resposta) {
  try {
    const corpo = await resposta.json();
    return corpo?.description ?? '(sem descrição)';
  } catch {
    return '(corpo ilegível)';
  }
}

// Resultado do ÚLTIMO envio. Vai junto no heartbeat (`global/status_bot`, que o
// bot já escreve a cada minuto e NÃO é cacheado) para a dashboard mostrar o
// erro na tela. Sem isso, um chat id errado morre no log do pm2 — que foi
// exatamente o que aconteceu na primeira configuração real.
let ultimoEnvio = null;

function registrarEnvio(ok, erro = null) {
  ultimoEnvio = { ok, erro, em: new Date().toISOString() };
}

/** Último resultado de envio ({ ok, erro, em }) ou null se nada foi tentado. */
export function ultimoResultadoEnvio() {
  return ultimoEnvio;
}

/** Zera o último resultado (testes). */
export function limparUltimoEnvio() {
  ultimoEnvio = null;
}

// ------------------------------------------------------------- formatação

const num = (v, casas = 2) => (Number.isFinite(v) ? v.toFixed(casas) : '—');
const dinheiro = (v, moeda) => (Number.isFinite(v) ? `${num(v)}${moeda ? ` ${moeda}` : ''}` : '—');

/**
 * Texto de uma operação executada/sugerida. Função PURA — testável sem rede.
 * Devolve null quando o evento não deve virar mensagem.
 */
export function formatarOperacao({ plataformaId, ativoId, operacao, moeda = null }) {
  if (!operacao) return null;
  const { tipo, status } = operacao;

  // Só o que interessa ao dono: o que aconteceu de fato e o que ele precisa fazer.
  if (status !== 'executada' && status !== 'sugerida') return null;
  if (tipo !== 'COMPRA' && tipo !== 'VENDA') return null;

  const par = escaparHTML(`${plataformaId}/${ativoId}`);
  const modo = operacao.modo === 'simulacao' ? ' <i>(simulação)</i>' : '';
  const porStop = operacao.origem_decisao === 'motor_stop_loss';

  if (status === 'sugerida') {
    // ALERTA DE OPORTUNIDADE (V8.22, §10.12): a COMPRA em plataforma assistida
    // vem SEM tamanho — o robô não sabe quanto há em caixa na corretora, e
    // fingir um total seria pior que não dizer nada. O texto muda junto, senão
    // o dono lê "execute" e procura na mensagem um número que não existe.
    if (operacao.quantidade == null && operacao.valor == null) {
      const fatia = Number.isFinite(operacao.percentual_sugerido)
        ? `\nFatia sugerida pela IA: <b>${operacao.percentual_sugerido}%</b> do que você quiser alocar.`
        : '';
      return (
        `🔔 <b>Oportunidade — você decide se executa</b>\n` +
        `${par}: <b>${escaparHTML(tipo)}</b> · preço de referência ${dinheiro(operacao.preco, moeda)}` +
        fatia +
        (operacao.justificativa_ia ? `\n\n<i>${escaparHTML(operacao.justificativa_ia)}</i>` : '') +
        `\n\nO robô não envia ordem nesta corretora. Se executar, registre pela dashboard.`
      );
    }
    return (
      `🔔 <b>Recomendação — execute na corretora</b>\n` +
      `${par}: <b>${escaparHTML(tipo)}</b> ${num(operacao.quantidade, 8)} @ ${dinheiro(operacao.preco, moeda)}\n` +
      `Total: ${dinheiro(operacao.valor, moeda)}\n` +
      (operacao.justificativa_ia ? `\n<i>${escaparHTML(operacao.justificativa_ia)}</i>\n` : '') +
      `\nDepois de executar, registre pela dashboard.`
    );
  }

  if (tipo === 'COMPRA') {
    return (
      `🟢 <b>Compra</b>${modo}\n` +
      `${par}: ${num(operacao.quantidade, 8)} @ ${dinheiro(operacao.preco, moeda)}\n` +
      `Total: ${dinheiro(operacao.valor, moeda)}`
    );
  }

  // VENDA: o lucro é a informação principal — e como ela foi decidida.
  const lucro = operacao.lucro_liquido;
  const sinal = Number.isFinite(lucro) && lucro < 0 ? '🔴' : '🔵';
  const porLiquidacao = operacao.origem_decisao === 'ia_modo_vendas';
  // Trava de lucro (V8.11): o Motor realizando o ganho. É o oposto do stop e
  // precisa de nome próprio no aviso — senão o dono vê "venda" e não sabe se o
  // robô se protegeu de uma queda ou se travou um lucro.
  const porTrava = operacao.origem_decisao === 'motor_trava_lucro';
  const titulo = porStop
    ? 'Venda por STOP-LOSS'
    : porTrava
      ? 'Venda pela TRAVA DE LUCRO'
      : porLiquidacao
        ? `Venda na liquidação (dia ${operacao.modo_vendas?.dia ?? '?'}/${operacao.modo_vendas?.dias_totais ?? '?'})`
        : 'Venda';
  const resultado = Number.isFinite(lucro)
    ? `\nResultado: <b>${lucro >= 0 ? '+' : ''}${dinheiro(lucro, moeda)}</b>`
    : '';
  const chao = porStop && Array.isArray(operacao.stop_loss) && operacao.stop_loss[0]?.motivo
    ? `\n<i>Chão: ${escaparHTML(operacao.stop_loss[0].motivo)}</i>`
    : '';
  return (
    `${sinal} <b>${titulo}</b>${modo}\n` +
    `${par}: ${num(operacao.quantidade, 8)} @ ${dinheiro(operacao.preco, moeda)}\n` +
    `Total: ${dinheiro(operacao.valor, moeda)}${resultado}${chao}`
  );
}

/** A qual toggle de evento uma operação pertence. */
export function eventoDaOperacao(operacao) {
  if (operacao?.status === 'sugerida') return 'recomendacao';
  if (operacao?.tipo === 'COMPRA') return 'compra';
  if (operacao?.tipo === 'VENDA') return 'venda';
  return null;
}

// --------------------------------------------------------------- envio

/**
 * Notifica uma operação. Best-effort: nunca lança, nunca bloqueia o ciclo.
 * `obterConfig` é injetável (o caller passa a leitura cacheada do catálogo).
 */
export async function notificarOperacao({ plataformaId, ativoId, operacao, moeda = null, config, fetchFn }) {
  try {
    const cfg = resolverConfig(config);
    if (!cfg) return false;
    const evento = eventoDaOperacao(operacao);
    if (!evento || !cfg.eventos[evento]) return false;
    const texto = formatarOperacao({ plataformaId, ativoId, operacao, moeda });
    if (!texto) return false;
    return await enviarMensagem(texto, cfg, { fetchFn });
  } catch (e) {
    log.aviso('Telegram: falha ao montar a notificação da operação', e);
    return false;
  }
}

/**
 * Notifica um PROBLEMA (quota da IA esgotada, corretora fora do ar).
 * `chave` identifica o problema para a trava anti-spam (ex.: "quota_ia:MB").
 */
export async function notificarProblema({ chave, titulo, detalhe = '', config, fetchFn, agoraMs = Date.now() }) {
  try {
    const cfg = resolverConfig(config);
    if (!cfg || !cfg.eventos.problema) return false;
    const ultimo = ultimoProblema.get(chave);
    // `Number.isFinite`, não `if (ultimo)`: o timestamp 0 é um valor legítimo e
    // falsy — com `&&` a trava vazaria um aviso extra.
    if (Number.isFinite(ultimo) && agoraMs - ultimo < INTERVALO_ANTISPAM_MS) return false; // já avisou
    const texto = `⚠️ <b>${escaparHTML(titulo)}</b>` + (detalhe ? `\n${escaparHTML(detalhe)}` : '');
    const enviou = await enviarMensagem(texto, cfg, { fetchFn });
    if (enviou) ultimoProblema.set(chave, agoraMs);
    return enviou;
  } catch (e) {
    log.aviso('Telegram: falha ao montar a notificação de problema', e);
    return false;
  }
}

/**
 * Envia o relatório periódico de decisões. Texto já vem pronto e formatado
 * (relatorioDecisoes.formatarRelatorio) — este módulo só transporta.
 */
export async function notificarRelatorio({ texto, config, fetchFn }) {
  try {
    const cfg = resolverConfig(config);
    if (!cfg || !cfg.eventos.relatorio) return false;
    if (!texto) return false;
    return await enviarMensagem(texto, cfg, { fetchFn });
  } catch (e) {
    log.aviso('Telegram: falha ao enviar o relatório de decisões', e);
    return false;
  }
}

/**
 * Envia o resultado da supervisão semanal (V7.2): diagnóstico, o que mudou no
 * prompt do analista e os palpites sobre posições abertas. Texto já vem pronto
 * (supervisor.formatarSupervisao) — este módulo só transporta.
 */
export async function notificarSupervisao({ texto, config, fetchFn }) {
  try {
    const cfg = resolverConfig(config);
    if (!cfg || !cfg.eventos.supervisao) return false;
    if (!texto) return false;
    return await enviarMensagem(texto, cfg, { fetchFn });
  } catch (e) {
    log.aviso('Telegram: falha ao enviar a supervisão semanal', e);
    return false;
  }
}

/**
 * Texto do aviso de atualização do jogo (fase 2 da Steam). Função PURA.
 *
 * Curto de propósito: o aviso serve para o dono SABER que saiu update, não
 * para ler o changelog no celular. Duas linhas da nota e o link — a nota
 * inteira quem lê é a IA, no prompt.
 */
export function formatarNoticiaJogo({ titulo, url, data, conteudo } = {}) {
  const linhas = [`🎮 <b>${escaparHTML(titulo || 'Atualização do jogo')}</b>`];
  if (data) linhas.push(new Date(data).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
  const resumo = String(conteudo ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
  if (resumo) linhas.push('', escaparHTML(resumo.length > 280 ? `${resumo.slice(0, 280)}…` : resumo));
  if (url) linhas.push('', escaparHTML(url));
  return linhas.join('\n');
}

/**
 * Avisa que saiu atualização do jogo. Sem trava anti-spam por tempo: a trava
 * aqui é o `gid` já visto (quem chama só notifica novidade), e engolir um
 * anúncio de verdade por causa de um relógio seria pior.
 */
export async function notificarNoticiaJogo({ noticia, config, fetchFn }) {
  try {
    const cfg = resolverConfig(config);
    if (!cfg || !cfg.eventos.noticia_jogo) return false;
    if (!noticia?.titulo) return false;
    return await enviarMensagem(formatarNoticiaJogo(noticia), cfg, { fetchFn });
  } catch (e) {
    log.aviso('Telegram: falha ao avisar sobre a atualização do jogo', e);
    return false;
  }
}

/**
 * Texto do alerta de preço-alvo (fase 5 da Steam). Função PURA.
 *
 * Diz o alvo E o preço de agora: "cruzou" sem o número obriga o dono a abrir a
 * dashboard só para saber o quanto.
 */
export function formatarAlertaPreco({ nome, tipo, alvo, preco, moeda = 'BRLS' } = {}) {
  const seta = tipo === 'abaixo' ? '🔻' : '🔺';
  const verbo = tipo === 'abaixo' ? 'caiu para' : 'subiu para';
  return [
    `${seta} <b>${escaparHTML(nome ?? 'item')}</b>`,
    `${verbo} ${formatarDinheiro(preco, moeda)} (seu alvo: ${formatarDinheiro(alvo, moeda)})`,
  ].join('\n');
}

/** Avisa que um item cruzou o preço-alvo. Não lança. */
export async function notificarAlertaPreco({ alerta, config, fetchFn }) {
  try {
    const cfg = resolverConfig(config);
    if (!cfg || !cfg.eventos.alerta_preco) return false;
    if (!alerta?.nome) return false;
    return await enviarMensagem(formatarAlertaPreco(alerta), cfg, { fetchFn });
  } catch (e) {
    log.aviso('Telegram: falha ao enviar o alerta de preço', e);
    return false;
  }
}

/**
 * Texto do lembrete da liquidação em curso (V8). Função PURA.
 *
 * Existe porque o modo vendas NÃO expira sozinho: foi decisão do dono que ele
 * dure até ser desligado. O risco disso é esquecê-lo ligado com a exceção da
 * regra 4 aberta — então o sistema cobra presença uma vez por dia.
 */
export function formatarModoVendas(estado) {
  if (!estado?.ativo) {
    return '▶ <b>Modo vendas desligado</b>\nA operação normal voltou: compras liberadas, ' +
      'venda no prejuízo só pelo stop-loss.';
  }
  const passouDaJanela = estado.dia > estado.dias_totais;
  return (
    `💰 <b>Modo vendas — dia ${estado.dia} de ${estado.dias_totais}</b>\n` +
    `Prejuízo aceito hoje: <b>${estado.perda_maxima_percentual}%</b> por posição.\n` +
    'Compras bloqueadas e supervisor pausado enquanto durar.' +
    (passouDaJanela
      ? '\n\n⚠️ A janela planejada terminou e o modo <b>continua ligado</b> — ' +
        'a tolerância está no teto. Desligue pela dashboard quando terminar.'
      : '')
  );
}

// Lembrete da liquidação: a trava anti-spam por chave (24 h) é justamente o
// "uma vez por dia" — reaproveitada aqui em vez de um agendador novo.
export async function notificarModoVendas({ estado, config, fetchFn, agoraMs = Date.now() }) {
  try {
    const cfg = resolverConfig(config);
    if (!cfg || !cfg.eventos.modo_vendas) return false;
    const chave = 'modo_vendas';
    if (!estado?.ativo) {
      // Desligou: avisa só se havia um episódio aberto (evita "desligado" no
      // boot de um sistema que nunca ligou o modo) e rearma a trava.
      if (!ultimoProblema.has(chave)) return false;
      ultimoProblema.delete(chave);
      return await enviarMensagem(formatarModoVendas(estado), cfg, { fetchFn });
    }
    const ultimo = ultimoProblema.get(chave);
    if (ultimo && agoraMs - ultimo < INTERVALO_ANTISPAM_MS) return false;
    ultimoProblema.set(chave, agoraMs);
    return await enviarMensagem(formatarModoVendas(estado), cfg, { fetchFn });
  } catch (e) {
    log.aviso('Telegram: falha ao avisar sobre o modo vendas', e);
    return false;
  }
}

// Confirmação de ativação: uma por configuração (token+chat) por processo.
let ativacaoConfirmada = null;

/**
 * Manda a mensagem de "avisos ligados" na PRIMEIRA vez que este processo vê uma
 * configuração válida e ligada — e de novo se o token ou o chat mudarem.
 *
 * É o teste de configuração do usuário: ele salva na dashboard e, no máximo um
 * TTL de catálogo depois (5 min), recebe a confirmação no celular. Evita que a
 * dashboard precise do token no navegador só para mandar uma mensagem de teste.
 */
export async function confirmarAtivacao({ config, fetchFn } = {}) {
  try {
    const cfg = resolverConfig(config);
    if (!cfg) {
      ativacaoConfirmada = null; // desligou: a próxima ativação avisa de novo
      return false;
    }
    const assinatura = `${cfg.token}:${cfg.chatId}`;
    if (ativacaoConfirmada === assinatura) return false;
    const enviou = await enviarMensagem(
      '✅ <b>Avisos ligados</b>\nA IA Investidora vai te avisar por aqui. ' +
        'Você escolhe quais eventos na Visão geral da dashboard.',
      cfg,
      { fetchFn },
    );
    // Só marca como confirmada quando REALMENTE chegou. Marcar antes do envio
    // faria uma falha passageira (rede, 5xx do Telegram) silenciar a
    // confirmação para sempre — e ela é justamente o teste de configuração do
    // usuário. Enquanto falhar, o próximo tick tenta de novo.
    if (enviou) ativacaoConfirmada = assinatura;
    return enviou;
  } catch (e) {
    log.aviso('Telegram: falha ao confirmar a ativação dos avisos', e);
    return false;
  }
}

/** Zera a confirmação de ativação (testes). */
export function limparAtivacao() {
  ativacaoConfirmada = null;
}

/**
 * Notifica a VOLTA ao normal de um problema (ex.: corretora autenticando de
 * novo). Libera a trava anti-spam daquela chave: o próximo episódio avisa na hora.
 */
export async function notificarRecuperacao({ chave, titulo, config, fetchFn }) {
  try {
    const cfg = resolverConfig(config);
    if (!cfg || !cfg.eventos.problema) return false;
    // Sem episódio aberto não há o que anunciar (evita "voltou" no boot).
    if (!ultimoProblema.has(chave)) return false;
    ultimoProblema.delete(chave);
    return await enviarMensagem(`✅ <b>${escaparHTML(titulo)}</b>`, cfg, { fetchFn });
  } catch (e) {
    log.aviso('Telegram: falha ao montar a notificação de recuperação', e);
    return false;
  }
}
