// supervisor.js — o AGENTE SUPERVISOR semanal (V7.2).
//
// O que ele é: uma segunda IA que, uma vez por semana, lê o retrato do que o
// ANALISTA fez (decisões, justificativas, posições, dinheiro) e reescreve uma
// camada do prompt dele. É a única peça do sistema que escreve na cabeça de
// quem decide — por isso todas as travas ficam do lado de cá, e não na
// confiança de que ele vai se comportar:
//
//   - a camada é RECORTADA por ativo e entra DEPOIS das regras gerais, que
//     continuam com prioridade sobre ela (montadorPrompt);
//   - o CONTRATO_SAIDA segue por último e imune (montadorPrompt);
//   - o validador recusa a versão inteira quando ela passa do tamanho ou tenta
//     mexer em formato/regra (validadorSupervisao) — e recusar significa
//     MANTER a camada anterior, nunca ficar sem nenhuma;
//   - o dono desliga tudo num campo (`global/supervisor.ativo`) e tem as 5
//     últimas versões para voltar atrás.
//
// O que ele NÃO faz: emitir ordem, mexer em posição, alterar config, escrever
// nas regras gerais/template/prompt do ativo (o que o dono escreveu é dele).
//
// Custo: roda 1×/semana. ~35 leituras por ativo (histórico recente + posições
// abertas + operações da janela) — no parque atual, algumas centenas por
// semana. Nada disso toca o caminho quente do tick de 1 min (invariante V5.2).

import {
  listarPlataformas,
  listarAtivos,
  obterRegrasGerais,
  obterPromptAtivo,
  obterPromptSupervisor,
  obterConfigSupervisor,
  obterSupervisao,
  salvarSupervisao,
  obterApiPlataforma,
  obterHistoricoRecenteAtivo,
  obterPosicoesAbertasAtivo,
  obterOperacoesDesdeAtivo,
  obterRelatorioDecisoes,
} from '../firebase/firebaseClient.js';
import { consultar } from '../ia/iaClient.js';
import { validarSupervisao } from '../ia/validadorSupervisao.js';
import { breakevenPosicao } from '../regras/regrasEngine.js';
import { filtrarPlataformas } from './instancia.js';
import { invalidarCatalogo } from './catalogo.js';
import { log } from '../utils/logger.js';

/** Uma rodada por semana. */
export const INTERVALO_SUPERVISAO_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Quantas análises recentes de cada ativo vão no retrato. 40 cobre com folga
 * uma semana de um ativo de 15 min que só chama a IA quando a variação passa do
 * mínimo, e mantém o prompt do supervisor num tamanho sadio.
 */
export const MAX_DECISOES_POR_ATIVO = 40;

/** Justificativas são cortadas neste tamanho — o padrão aparece na repetição, não no detalhe. */
const MAX_JUSTIFICATIVA = 220;

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * A rodada semanal roda no INÍCIO DO DIA DE QUOTA do Gemini (a cota gratuita
 * por modelo vira à meia-noite no horário do Pacífico). Assim o supervisor pega
 * o melhor modelo da cadeia com a quota inteira disponível, em vez de disputar
 * com o analista, que consome o dia todo.
 *
 * Função pura, com o fuso resolvido pelo Intl (cobre horário de verão sozinho).
 */
export function naJanelaDeQuota(agora = new Date(), horaLimite = 6) {
  const hora = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      hour12: false,
    }).format(agora),
  );
  return Number.isFinite(hora) && hora < horaLimite;
}

/**
 * Decide se a rodada semanal deve acontecer AGORA. Função pura — o agendamento
 * é testável sem relógio nem Firestore.
 *
 * A régua é o `gerado_em` PERSISTIDO (mesma disciplina do relatório de
 * decisões): reiniciar o bot não dispara supervisão fora de hora nem empurra a
 * próxima para frente.
 */
export function deveSupervisionar({
  supervisao,
  agora = new Date(),
  forcar = false,
  config = {},
  modoVendas = null,
  iaDesligada = false,
} = {}) {
  // KILL-SWITCH DA IA (V8.10): o dono desligou a chave da IA na dashboard, e o
  // supervisor é uma chamada de IA como qualquer outra — a mais cara delas.
  // Antes do `forcar` pelo mesmo motivo do modo vendas: "rodar agora" adianta a
  // rodada, não autoriza usar uma chave que o dono acabou de desligar.
  if (iaDesligada) return { rodar: false, motivo: 'IA desligada — supervisor pausado' };
  // MODO VENDAS (V8): pausado, e isto vem ANTES do `forcar` de propósito. O
  // supervisor audita decisões de ENTRADA — quando comprar, que chão usar, que
  // tamanho — e durante uma liquidação reescreveria o prompt do analista com
  // conclusões sobre um comportamento que o sistema deixou de ter. O botão
  // "rodar agora" não é exceção: ele adianta a rodada, não muda o que ela é.
  if (modoVendas?.ativo) return { rodar: false, motivo: 'modo vendas ligado — supervisor pausado' };
  if (config.ativo === false && !forcar) return { rodar: false, motivo: 'supervisor desligado' };
  if (forcar) return { rodar: true, motivo: 'pedido manual' };
  const gerado = supervisao?.gerado_em ? new Date(supervisao.gerado_em).getTime() : null;
  if (gerado && agora.getTime() - gerado < INTERVALO_SUPERVISAO_MS) {
    return { rodar: false, motivo: 'janela de 7 dias ainda não venceu' };
  }
  if (!naJanelaDeQuota(agora)) return { rodar: false, motivo: 'fora da janela de quota' };
  return { rodar: true, motivo: gerado ? 'janela vencida' : 'primeira rodada' };
}

// ------------------------------------------------------------------ retrato

/** Só o essencial de cada análise — o supervisor procura PADRÃO, não detalhe. */
function resumirAnalise(h) {
  const d = h.decisao_ia ?? {};
  return {
    horario: h.horario ?? null,
    preco: r2(h.preco_atual),
    acao: d.acao ?? null,
    confianca: d.confianca ?? null,
    justificativa: typeof d.justificativa === 'string' ? d.justificativa.slice(0, MAX_JUSTIFICATIVA) : null,
    stop_loss: d.stop_loss ?? null,
    resultado_regras: h.resultado_regras?.status ?? null,
    posicoes_abertas_no_momento: Array.isArray(h.posicoes) ? h.posicoes.length : null,
  };
}

/**
 * Lote vivo, com o mesmo vocabulário que o analista vê no JSON dele — inclusive
 * o breakeven pela taxa de compra EFETIVA (§10.4): se o supervisor visse um
 * número diferente do que o analista vê, ele passaria a semana cobrando saídas
 * que o Motor rejeitaria.
 */
function resumirPosicao(pos, config) {
  let breakeven = null;
  try {
    breakeven = breakevenPosicao(pos, config);
  } catch {
    breakeven = null; // config incompleta: o campo some, o retrato segue
  }
  return {
    id: pos.id,
    origem: pos.origem ?? 'bot',
    status: pos.status ?? null,
    // O campo do doc é `abertura` (posicoes.js) — `aberta_em` ia sempre null, e
    // o supervisor passava a datar o lote adivinhando pelo id.
    aberta_em: pos.abertura ?? null,
    quantidade: pos.quantidade ?? null,
    preco_compra: r2(pos.preco_compra),
    stop_loss: r2(pos.stop_loss),
    stop_loss_inicial: r2(pos.stop_loss_inicial),
    // QUANDO o chão se moveu pela última vez. Sem isto o supervisor não
    // distingue "chão nunca protegido" de "trailing já subiu o chão", e conclui
    // desprotegido em posição protegida — foi o que produziu, na 1ª rodada
    // real, uma instrução para APERTAR um chão que o Motor já tinha otimizado.
    stop_loss_atualizado_em: pos.stop_loss_atualizado_em ?? null,
    stop_loss_motivo: pos.stop_loss_motivo ?? null,
    preco_minimo_venda_lucrativa: r2(breakeven),
    // Lucro projetado do lote, congelado na ÚLTIMA análise (o retrato não
    // consulta corretora). Sem ele o supervisor não consegue responder a
    // pergunta que mais importa — havia lote em lucro sendo ignorado?
    lucro_liquido_se_vender_agora: r2(pos.lucro_se_vender_agora),
  };
}

/** Só o que descreve a decisão — sem ids internos nem campos de execução. */
function resumirOperacao(op) {
  return {
    horario: op.horario ?? null,
    tipo: op.tipo,
    status: op.status,
    origem_decisao: op.origem_decisao ?? 'ia',
    // O PREÇO da operação é o que permite separar stop mal calibrado de GAP de
    // abertura: comparado com o preço da última análise antes do fechamento,
    // uma distância grande denuncia que o chão foi ultrapassado no salto, não
    // que estava apertado demais. Sem este campo, distinguir os dois casos
    // exigiria adivinhação — e adivinhar é justamente o que o supervisor não
    // pode fazer.
    preco: r2(op.preco),
    quantidade: op.quantidade ?? null,
    valor: r2(op.valor),
    taxa: r2(op.taxa),
    lucro_liquido: r2(op.lucro_liquido),
    posicoes: op.posicoes ?? null, // liga a operação aos lotes que ela abriu/fechou
    motivo_rejeicao: op.motivo_rejeicao ?? null,
    // Ordem que a corretora recusou (status 'erro'): sem o motivo, uma
    // restrição da plataforma vira "o analista não operou" no diagnóstico.
    motivo_erro: op.motivo_erro ?? null,
  };
}

/**
 * Monta o JSON que vai para o supervisor. Faz as leituras do Firestore, mas
 * nenhuma chamada de IA — dá para inspecionar o retrato sem gastar quota.
 */
export async function coletarRetrato({ agora = new Date(), dias = 7 } = {}) {
  const fim = agora.toISOString();
  const inicio = new Date(agora.getTime() - dias * 24 * 60 * 60 * 1000).toISOString();

  const [relatorio, supervisaoVigente, regrasGerais] = await Promise.all([
    obterRelatorioDecisoes(),
    obterSupervisao(),
    obterRegrasGerais(),
  ]);

  const ativos = [];
  const plataformas = filtrarPlataformas(await listarPlataformas()).filter((p) => p.ativa !== false);

  for (const plataforma of plataformas) {
    let lista = [];
    try {
      lista = await listarAtivos(plataforma.id);
    } catch (e) {
      log.aviso(`supervisor: não foi possível listar os ativos de ${plataforma.id}`, e);
      continue;
    }
    for (const ativo of lista) {
      const config = ativo.config ?? {};
      if (config.ativo === false) continue; // ativo desligado não tem o que supervisionar
      const modo = config.modo_simulacao === false ? 'real' : 'simulacao';
      try {
        const [historico, posicoes, operacoes, promptAtivo] = await Promise.all([
          obterHistoricoRecenteAtivo(plataforma.id, ativo.id, MAX_DECISOES_POR_ATIVO),
          obterPosicoesAbertasAtivo(plataforma.id, ativo.id, modo),
          obterOperacoesDesdeAtivo(plataforma.id, ativo.id, inicio),
          obterPromptAtivo(plataforma.id, ativo.id),
        ]);
        ativos.push({
          plataforma: plataforma.id,
          ativo: ativo.id,
          nome: ativo.manifest?.nome ?? ativo.id,
          tipo: ativo.manifest?.tipo ?? null,
          moeda: plataforma.moeda ?? 'BRL',
          modo,
          assistida: plataforma.assistida === true,
          config: {
            taxa_compra_percentual: config.taxa_compra_percentual ?? null,
            taxa_venda_percentual: config.taxa_venda_percentual ?? null,
            orcamento_percentual: config.orcamento_percentual ?? null,
            percentual_minimo_variacao: config.percentual_minimo_variacao ?? null,
            tempo_entre_analises_minutos: config.tempo_entre_analises_minutos ?? null,
            stop_loss_max_distancia_percentual: config.stop_loss_max_distancia_percentual ?? null,
            stop_loss_trailing_percentual: config.stop_loss_trailing_percentual ?? null,
          },
          prompt_do_ativo: promptAtivo?.conteudo?.trim() || null,
          posicoes_abertas: posicoes.map((p) => resumirPosicao(p, config)),
          // Só as análises que de fato chamaram a IA: as `verificacao` (filtro
          // de variação) não têm decisão e só diluiriam o retrato.
          decisoes_recentes: historico.filter((h) => h.tipo === 'analise').map(resumirAnalise),
          operacoes: operacoes.map(resumirOperacao),
        });
      } catch (e) {
        log.aviso(`supervisor: falha ao montar o retrato de ${plataforma.id}/${ativo.id} — seguindo`, e);
      }
    }
  }

  return {
    janela: { inicio, fim, dias },
    relatorio: relatorio ?? null,
    supervisao_vigente: supervisaoVigente?.conteudo
      ? {
          conteudo: supervisaoVigente.conteudo,
          versao: supervisaoVigente.versao ?? 0,
          atualizado_em: supervisaoVigente.atualizado_em ?? null,
          origem: supervisaoVigente.origem ?? null,
        }
      : null,
    prompts_vigentes: { regras_gerais: regrasGerais?.conteudo ?? null },
    ativos,
  };
}

/**
 * Roda a supervisão: monta o retrato, consulta a IA, valida e persiste a camada
 * nova. NÃO notifica (quem chama decide) e NÃO decide se está na hora
 * (`deveSupervisionar` faz isso) — assim dá para rodar sob demanda pela
 * dashboard sem duplicar regra.
 *
 * Devolve { ok, motivo?, supervisao?, retrato } — nunca lança por erro da IA:
 * falhar aqui significa a camada anterior continuar valendo, que é o
 * comportamento correto.
 */
export async function rodarSupervisao({ agora = new Date(), consultarFn = consultar } = {}) {
  const config = await obterConfigSupervisor();
  const dias = Number(config.dias_janela) > 0 ? Number(config.dias_janela) : 7;
  const promptDoc = await obterPromptSupervisor();
  const promptSistema = promptDoc?.conteudo?.trim();
  if (!promptSistema) {
    return { ok: false, motivo: 'instruções do supervisor ausentes (global/supervisor_prompt vazio)' };
  }

  const retrato = await coletarRetrato({ agora, dias });
  if (retrato.ativos.length === 0) {
    return { ok: false, motivo: 'nenhum ativo ligado para supervisionar', retrato };
  }

  // A chave da IA é a mesma do analista — vem da primeira plataforma que a
  // tiver configurada (o supervisor é global, não pertence a uma corretora).
  const apiKey = await primeiraChaveIA();
  if (!apiKey) return { ok: false, motivo: 'nenhuma chave da IA configurada', retrato };

  let bruto;
  try {
    bruto = await consultarFn({
      promptSistema,
      entrada: retrato,
      apiKey,
      modelos: config.modelos_ia,
    });
  } catch (e) {
    log.aviso('supervisor: a IA não respondeu — a camada anterior continua valendo', e);
    return { ok: false, motivo: `IA indisponível: ${e.message}`, retrato };
  }

  const resultado = validarSupervisao(bruto.texto);
  if (!resultado.valida) {
    // Recusa é ESPERADA e segura: o prompt do analista não muda.
    log.erro('supervisor: resposta recusada pelo validador — camada anterior mantida', {
      motivo: resultado.motivo,
      modelo: bruto.modelo,
    });
    return { ok: false, motivo: `resposta inválida: ${resultado.motivo}`, retrato };
  }

  const doc = await salvarSupervisao({
    conteudo: resultado.supervisao.conteudo,
    diagnostico: resultado.supervisao.diagnostico,
    mudancas: resultado.supervisao.mudancas,
    palpites: resultado.supervisao.palpites,
    confianca: resultado.supervisao.confianca,
    modelo: bruto.modelo,
    janela: retrato.janela,
    gerado_em: agora.toISOString(),
    origem: 'supervisor',
  });
  // A camada é lida pelo ciclo através do CATÁLOGO: sem isto, o analista
  // continuaria vendo a versão antiga por até 5 minutos (invariante V5.2 —
  // escrita do BOT em doc cacheado invalida o catálogo).
  invalidarCatalogo();

  log.info('supervisão semanal atualizada', {
    versao: doc.versao,
    modelo: bruto.modelo,
    confianca: resultado.supervisao.confianca,
    mudancas: resultado.supervisao.mudancas.length,
    palpites: resultado.supervisao.palpites.length,
  });
  return { ok: true, supervisao: doc, retrato };
}

/** Primeira chave da IA encontrada entre as plataformas (o supervisor é global). */
async function primeiraChaveIA() {
  for (const plataforma of await listarPlataformas()) {
    try {
      const api = await obterApiPlataforma(plataforma.id);
      if (api?.api_key_ia) return api.api_key_ia;
    } catch {
      // plataforma sem credenciais legíveis: tenta a próxima
    }
  }
  return process.env.GEMINI_API_KEY || null;
}

// --------------------------------------------------------------- formatação

/** Texto do aviso de supervisão para o Telegram (HTML). Função pura. */
export function formatarSupervisao(sup = {}) {
  const l = [];
  l.push(`🧭 <b>Supervisão semanal</b> (v${sup.versao ?? '?'})`);
  if (sup.confianca !== null && sup.confianca !== undefined) {
    l.push(`<i>confiança na amostra: ${sup.confianca}%</i>`);
  }
  if (sup.diagnostico) {
    l.push('');
    l.push(sup.diagnostico);
  }
  const mudancas = sup.mudancas ?? [];
  if (mudancas.length) {
    l.push('');
    l.push('<b>O que mudou no prompt do analista</b>');
    for (const m of mudancas) l.push(`• ${m}`);
  } else {
    l.push('');
    l.push('<i>Nenhuma mudança no prompt do analista nesta semana.</i>');
  }
  const palpites = sup.palpites ?? [];
  if (palpites.length) {
    l.push('');
    l.push('<b>Posições abertas — observações</b>');
    for (const p of palpites) {
      const onde = [p.plataforma, p.ativo].filter(Boolean).join('/');
      l.push(`• ${onde ? `<b>${onde}</b>: ` : ''}${p.observacao}`);
    }
  }
  return l.join('\n');
}
