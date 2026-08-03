// relatorioDecisoes.js — mede as DECISÕES do sistema (V7, análise · parte 1).
//
// Por que existe: o episódio da PBR (ROADMAP V6.6.1) mostrou que a IA quase não
// vendia havia dias, e ninguém percebeu — só apareceu porque o dono estranhou o
// lucro sumindo. Não havia nenhuma medição das decisões; para responder
// qualquer pergunta era preciso escrever um script à mão e ler no terminal.
//
// Este módulo transforma aquela consulta em código que roda sozinho e chega
// pelo Telegram. NÃO usa IA e NÃO muda nada da operação: só lê, conta e conta a
// história. A camada de IA (sugerir melhorias de prompt) virá por cima destes
// números — interpretar dado que ninguém validou seria opinião, não análise.
//
// Custo de leitura: a janela é limitada por data e o caminho é
// `operacoes desde X` (1 query por ativo) + os docs das posições citadas nas
// vendas (poucos). NUNCA varre o histórico inteiro — a distribuição de decisões
// vem de contadores que o `cicloAtivo` mantém no doc de estado, que ele já
// escreve todo ciclo (custo zero, invariante V5.2).

import {
  listarPlataformas,
  listarAtivos,
  obterOperacoesDesdeAtivo,
  obterPosicaoAtivo,
  obterEstadoAtivo,
  obterRelatorioDecisoes,
  salvarRelatorioDecisoes,
} from '../firebase/firebaseClient.js';
import { filtrarPlataformas } from './instancia.js';
import { log } from '../utils/logger.js';

/** Intervalo padrão entre relatórios. */
export const INTERVALO_RELATORIO_MS = 7 * 24 * 60 * 60 * 1000;

const num = (v) => (Number.isFinite(v) ? v : null);
const soma = (lista) => lista.reduce((s, v) => s + v, 0);

/** Mediana de uma lista de números (lista vazia → null). */
export function mediana(valores) {
  if (!valores.length) return null;
  const ord = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ord.length / 2);
  return ord.length % 2 ? ord[meio] : (ord[meio - 1] + ord[meio]) / 2;
}

/**
 * Risco:retorno REALIZADO de um lote fechado.
 *
 *   risco  = (preço de entrada − chão DECLARADO na entrada) × quantidade
 *   razão  = lucro líquido realizado / risco
 *
 * Usa `stop_loss_inicial` (congelado na abertura), nunca `stop_loss` — este
 * sobe com o trailing e no fechamento já não diz o risco que foi aceito.
 * Posição sem chão declarado (externa, manual, anterior à V6.6) não tem risco
 * conhecido e fica FORA da amostra, em vez de entrar com um número inventado.
 */
export function razaoRiscoRetorno(posicao) {
  const entrada = num(posicao?.preco_compra);
  const chao = num(posicao?.stop_loss_inicial);
  const qtd = num(posicao?.quantidade);
  const lucro = num(posicao?.lucro_liquido);
  if (entrada === null || chao === null || qtd === null || lucro === null) return null;
  const risco = (entrada - chao) * qtd;
  if (!(risco > 0)) return null;
  return { risco, lucro, razao: lucro / risco };
}

/**
 * ASSIMETRIA REALIZADA (V6.7) — "ganhou mais quando acertou do que perdeu
 * quando errou?", medida só com `lucro_liquido` dos lotes fechados.
 *
 * Por que ela existe ao lado do `razaoRiscoRetorno`: aquele é a métrica melhor
 * (mede contra o risco ACEITO na entrada), mas exige `stop_loss_inicial`, campo
 * que só passou a ser gravado na V6.6.2 — em 2026-07-25, 0 dos 23 lotes fechados
 * em produção o tinham, e a métrica devolvia "sem amostra" para 100% deles.
 * Esta aqui usa o que todo lote fechado tem desde a V1, então responde HOJE, e
 * continua respondendo quando a outra passar a ter amostra. Não é substituta: é
 * a que funciona antes.
 *
 * Devolve null com menos de um lote; `razao` é null quando falta um dos lados
 * (sem perdas não existe proporção — e fingir que existe seria pior que omitir).
 *
 * @param {number[]} lucros  lucro líquido de cada lote fechado, na MESMA moeda
 */
export function assimetriaRealizada(lucros = []) {
  const validos = lucros.filter((v) => Number.isFinite(v));
  if (validos.length === 0) return null;
  const ganhos = validos.filter((v) => v > 0);
  const perdas = validos.filter((v) => v < 0);
  const mediaG = ganhos.length ? soma(ganhos) / ganhos.length : null;
  const mediaP = perdas.length ? Math.abs(soma(perdas) / perdas.length) : null;
  return {
    n: validos.length,
    ganhos: ganhos.length,
    perdas: perdas.length,
    ganho_medio: mediaG,
    perda_media: mediaP,
    maior_ganho: ganhos.length ? Math.max(...ganhos) : null,
    maior_perda: perdas.length ? Math.abs(Math.min(...perdas)) : null,
    // O número da V6.7: > 1 é o desenho vencedor (ganhos maiores que as perdas),
    // < 1 é o inverso — e o inverso perde dinheiro no longo prazo mesmo com
    // taxa de acerto alta, que é justamente o que esconde o problema.
    razao: mediaG !== null && mediaP !== null && mediaP > 0 ? mediaG / mediaP : null,
    taxa_acerto: ganhos.length / validos.length,
    // Quanto cada lote rendeu EM MÉDIA. É o juiz final: negativo significa que a
    // estratégia perde dinheiro repetida, por melhor que pareça a taxa de acerto.
    esperanca: soma(validos) / validos.length,
  };
}

/**
 * CAPTURA DO PICO (V8.5) — de todo o avanço que o lote teve, quanto a saída
 * levou para casa?
 *
 *   avanço máximo    = (pico observado ÷ preço de entrada − 1) × 100
 *   avanço capturado = (preço de venda ÷ preço de entrada − 1) × 100
 *   captura          = capturado ÷ máximo
 *
 * É a régua da saída PADRÃO do sistema (§10.2.1, o chão que sobe). O trailing
 * SEMPRE devolve alguma coisa — essa é a natureza dele; a pergunta é quanto.
 * Captura de 0,7 significa que o lote subiu 10% e a saída pegou 7. Persistindo
 * baixa, a distância do trailing está larga demais para o ativo; perto de 1 com
 * lucro pequeno, está apertada e corta a perna antes de ela andar.
 *
 * Tudo em PREÇO, sem taxas nos dois lados: é uma proporção entre dois avanços,
 * e misturar taxa só em um deles a distorceria. Lote que nunca subiu acima da
 * entrada não tem proporção possível e fica FORA da amostra — não vira zero.
 */
export function capturaDoPico(posicao) {
  const entrada = num(posicao?.preco_compra);
  const pico = num(posicao?.preco_maximo);
  const saida = num(posicao?.preco_venda);
  if (entrada === null || pico === null || saida === null || entrada <= 0) return null;
  const maximo = (pico / entrada - 1) * 100;
  if (!(maximo > 0)) return null;
  const capturado = (saida / entrada - 1) * 100;
  return { avanco_maximo: maximo, avanco_capturado: capturado, captura: capturado / maximo };
}

/**
 * Resume um conjunto de operações + as posições que elas fecharam.
 * Função PURA: recebe tudo pronto, não toca em rede nem banco.
 *
 * @param {object} p
 *   operacoes    — operações da janela (qualquer status)
 *   posicoesPorId — Map id → doc da posição (só as citadas nas vendas)
 *   moeda        — moeda da plataforma, para separar o dinheiro
 */
export function resumirOperacoes({ operacoes = [], posicoesPorId = new Map(), moeda = 'BRL' }) {
  const r = {
    moeda,
    compras: 0,
    vendas: 0,
    vendas_por_stop: 0,
    sugeridas: 0,
    rejeitadas: 0,
    erros: 0,
    lucro_realizado: 0,
    taxas_pagas: 0,
    volume: 0,
    fechamentos: {},   // motivo → { n, positivas, negativas, resultado }
    rr: [],            // razões risco:retorno das posições fechadas com chão
    lucros: [],        // lucro de CADA lote fechado (base da assimetria — V6.7)
    picos: [],         // captura do pico de cada lote fechado (V8.5)
  };

  for (const op of operacoes) {
    if (op.status === 'sugerida') { r.sugeridas++; continue; }
    if (op.status === 'rejeitada_saldo' || op.status === 'rejeitada_regras') { r.rejeitadas++; continue; }
    if (op.status === 'erro') { r.erros++; continue; }
    if (op.status !== 'executada') continue;
    if (op.tipo !== 'COMPRA' && op.tipo !== 'VENDA') continue; // DIVIDENDO é informativo

    if (Number.isFinite(op.taxa)) r.taxas_pagas += op.taxa;
    if (Number.isFinite(op.valor)) r.volume += op.valor;

    if (op.tipo === 'COMPRA') { r.compras++; continue; }

    r.vendas++;
    const porStop = op.origem_decisao === 'motor_stop_loss';
    if (porStop) r.vendas_por_stop++;
    if (Number.isFinite(op.lucro_liquido)) r.lucro_realizado += op.lucro_liquido;

    for (const id of op.posicoes ?? []) {
      const pos = posicoesPorId.get(id);
      if (!pos) continue;
      const motivo = pos.fechada_por ?? (porStop ? 'stop_loss' : 'lucro');
      const b = (r.fechamentos[motivo] ??= { n: 0, positivas: 0, negativas: 0, resultado: 0 });
      b.n++;
      const lucro = num(pos.lucro_liquido);
      if (lucro !== null) {
        b.resultado += lucro;
        if (lucro >= 0) b.positivas++; else b.negativas++;
        r.lucros.push(lucro); // base da assimetria (V6.7)
      }
      const rr = razaoRiscoRetorno(pos);
      if (rr) r.rr.push(rr.razao);
      const cap = capturaDoPico(pos);
      if (cap) r.picos.push(cap);
    }
  }
  return r;
}

/** Junta os resumos por moeda e consolida as contagens (que não têm moeda). */
export function consolidar(resumos) {
  const total = {
    compras: 0, vendas: 0, vendas_por_stop: 0, sugeridas: 0, rejeitadas: 0, erros: 0,
    fechamentos: {},
    por_moeda: {},
    rr: { amostras: 0, media: null, mediana: null, melhor: null, pior: null },
    // Captura do pico (V8.5). Fica no TOPO, fora de `por_moeda`, porque é uma
    // proporção entre dois percentuais — não é dinheiro e não sofre do problema
    // de somar moedas diferentes.
    captura: { amostras: 0, mediana: null, avanco_maximo_medio: null, avanco_capturado_medio: null },
  };
  const razoes = [];
  const picos = [];

  for (const r of resumos) {
    for (const k of ['compras', 'vendas', 'vendas_por_stop', 'sugeridas', 'rejeitadas', 'erros']) {
      total[k] += r[k];
    }
    for (const [motivo, b] of Object.entries(r.fechamentos)) {
      const alvo = (total.fechamentos[motivo] ??= { n: 0, positivas: 0, negativas: 0 });
      alvo.n += b.n;
      alvo.positivas += b.positivas;
      alvo.negativas += b.negativas;
    }
    // Dinheiro NUNCA se soma entre moedas (mesma regra da visão geral) — e a
    // ASSIMETRIA também não: comparar um ganho em USD com uma perda em BRL
    // produziria uma razão sem significado nenhum.
    const m = (total.por_moeda[r.moeda] ??= { lucro_realizado: 0, taxas_pagas: 0, volume: 0, lucros: [] });
    m.lucro_realizado += r.lucro_realizado;
    m.taxas_pagas += r.taxas_pagas;
    m.volume += r.volume;
    m.lucros.push(...r.lucros);
    razoes.push(...r.rr);
    picos.push(...(r.picos ?? []));
  }

  for (const m of Object.values(total.por_moeda)) {
    m.assimetria = assimetriaRealizada(m.lucros);
    delete m.lucros; // já consumida; o doc guarda a conclusão, não a matéria-prima
  }

  if (razoes.length) {
    total.rr = {
      amostras: razoes.length,
      media: soma(razoes) / razoes.length,
      mediana: mediana(razoes),
      melhor: Math.max(...razoes),
      pior: Math.min(...razoes),
    };
  }

  if (picos.length) {
    // MEDIANA na captura, não média: uma saída que pegou 5% de um avanço de
    // 60% puxa a média para baixo e sugere um trailing largo que talvez não
    // exista. A mediana descreve o lote típico, que é a pergunta.
    total.captura = {
      amostras: picos.length,
      mediana: mediana(picos.map((p) => p.captura)),
      avanco_maximo_medio: soma(picos.map((p) => p.avanco_maximo)) / picos.length,
      avanco_capturado_medio: soma(picos.map((p) => p.avanco_capturado)) / picos.length,
    };
  }
  return total;
}

/**
 * Delta das decisões da IA entre dois retratos dos contadores acumulados.
 * Contador que ANDOU PARA TRÁS (ativo recriado, estado apagado) é tratado como
 * começo novo: vale o valor atual, nunca um delta negativo.
 */
export function deltaDecisoes(atual = {}, anterior = {}) {
  const d = { COMPRAR: 0, VENDER: 0, AGUARDAR: 0 };
  for (const acao of Object.keys(d)) {
    const a = Number(atual[acao]) || 0;
    const b = Number(anterior[acao]) || 0;
    d[acao] = a >= b ? a - b : a;
  }
  d.total = d.COMPRAR + d.VENDER + d.AGUARDAR;
  return d;
}

// --------------------------------------------------------------- formatação

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const dinheiro = (v, moeda) => `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(2)} ${moeda}`;

/** Texto do relatório para o Telegram (HTML). Função pura. */
export function formatarRelatorio(rel) {
  const l = [];
  const dias = rel.janela?.dias ?? 7;
  l.push(`📊 <b>Relatório de decisões — ${dias} dias</b>`);
  l.push(`<i>${(rel.janela?.inicio ?? '').slice(0, 10)} a ${(rel.janela?.fim ?? '').slice(0, 10)}</i>`);

  // 1) O que a IA decidiu. É a métrica que revelou o problema da PBR.
  const d = rel.decisoes ?? {};
  if (d.total > 0) {
    l.push('');
    l.push(`<b>Decisões da IA</b> (${d.total} análises)`);
    l.push(`comprar ${d.COMPRAR} · vender ${d.VENDER} · aguardar ${d.AGUARDAR}`);
    const agir = d.COMPRAR + d.VENDER;
    l.push(`agiu em ${pct(agir / d.total)} das análises`);
  }

  // 2) Como as posições fecharam — a medição que estava pendente.
  const f = rel.fechamentos ?? {};
  const motivos = Object.entries(f).filter(([, b]) => b.n > 0);
  if (motivos.length) {
    l.push('');
    l.push('<b>Posições fechadas</b>');
    for (const [motivo, b] of motivos) {
      const nome = { lucro: 'realização (IA)', stop_loss: 'stop-loss (Motor)', manual: 'registro manual', externa: 'saída externa' }[motivo] ?? motivo;
      l.push(`${nome}: ${b.n} — ${b.positivas} no lucro, ${b.negativas} no prejuízo`);
    }
  } else {
    l.push('');
    l.push('<b>Posições fechadas</b>: nenhuma no período');
  }

  // 3) Dinheiro, por moeda (nunca somado entre moedas).
  const moedas = Object.entries(rel.por_moeda ?? {});
  if (moedas.length) {
    l.push('');
    l.push('<b>Resultado realizado</b>');
    for (const [moeda, m] of moedas) {
      l.push(`${dinheiro(m.lucro_realizado, moeda)} (taxas: ${dinheiro(m.taxas_pagas, moeda)})`);
    }
  }

  // 4) ASSIMETRIA (V6.7) — vem ANTES do risco:retorno de propósito: ela responde
  // hoje, com o `lucro_liquido` que todo lote tem, enquanto o R:R depende de um
  // campo que boa parte dos lotes antigos não carrega.
  for (const [moeda, m] of moedas) {
    const a = m.assimetria;
    if (!a || a.n === 0) continue;
    l.push('');
    l.push(`<b>Assimetria — ${moeda}</b> (${a.n} lote(s) fechado(s))`);
    l.push(
      `${a.ganhos} ganho(s) · média ${a.ganho_medio === null ? '—' : dinheiro(a.ganho_medio, moeda)}` +
        `${a.maior_ganho === null ? '' : ` · maior ${dinheiro(a.maior_ganho, moeda)}`}`,
    );
    l.push(
      `${a.perdas} perda(s) · média ${a.perda_media === null ? '—' : dinheiro(a.perda_media, moeda)}` +
        `${a.maior_perda === null ? '' : ` · pior ${dinheiro(a.maior_perda, moeda)}`}`,
    );
    if (a.razao !== null) {
      const sinal = a.razao >= 1 ? '✅' : '⚠️';
      l.push(`${sinal} ganho médio ÷ perda média = <b>${a.razao.toFixed(2)}×</b>`);
    }
    l.push(`acerto ${pct(a.taxa_acerto)} · por lote ${dinheiro(a.esperanca, moeda)}`);
    if (a.razao !== null && a.razao < 1) {
      l.push('<i>abaixo de 1× as perdas são maiores que os ganhos: taxa de acerto alta não salva isso</i>');
    }
  }

  // 5) Risco:retorno — a métrica melhor, quando há chão inicial gravado.
  const rr = rel.rr ?? {};
  l.push('');
  if (rr.amostras > 0) {
    l.push('<b>Risco:retorno realizado</b>');
    l.push(`mediana ${rr.mediana.toFixed(2)}× · média ${rr.media.toFixed(2)}× (${rr.amostras} lote(s))`);
    l.push(`melhor ${rr.melhor.toFixed(2)}× · pior ${rr.pior.toFixed(2)}×`);
    l.push('<i>quanto ganhou por unidade de risco aceita na entrada; abaixo de 1× o lote rendeu menos do que arriscou</i>');
  } else {
    l.push('<b>Risco:retorno</b>: sem amostra (nenhum lote fechado tinha chão declarado na entrada)');
    l.push('<i>o campo só passou a ser gravado na V6.6.2 — lotes abertos antes disso não entram</i>');
  }

  // 6) CAPTURA DO PICO (V8.5) — a régua da saída padrão (o chão que sobe).
  const c = rel.captura ?? {};
  if (c.amostras > 0) {
    l.push('');
    l.push('<b>Captura do pico</b>');
    l.push(
      `subiu ${c.avanco_maximo_medio.toFixed(1)}% em média · saiu com ${c.avanco_capturado_medio.toFixed(1)}%` +
        ` (${c.amostras} lote(s))`,
    );
    l.push(`levou <b>${pct(c.mediana)}</b> do avanço no lote típico`);
    l.push('<i>o chão que sobe sempre devolve um pedaço; muito baixo = trailing largo demais para o ativo</i>');
  }

  const o = rel;
  if (o.sugeridas || o.rejeitadas || o.erros) {
    l.push('');
    const partes = [];
    if (o.sugeridas) partes.push(`${o.sugeridas} recomendação(ões)`);
    if (o.rejeitadas) partes.push(`${o.rejeitadas} rejeitada(s) pelo Motor`);
    if (o.erros) partes.push(`${o.erros} com erro`);
    l.push(`<i>${partes.join(' · ')}</i>`);
  }
  return l.join('\n');
}

// ------------------------------------------------------------- orquestração

/**
 * Gera o relatório da janela, persiste em `global/relatorio_decisoes` e devolve
 * o objeto. Trabalho GLOBAL (varre todas as plataformas): só a instância
 * PRIMÁRIA deve chamar, como o `renda_real`.
 */
export async function gerarRelatorioDecisoes({ agora = new Date(), dias = 7 } = {}) {
  const fim = agora.toISOString();
  const inicio = new Date(agora.getTime() - dias * 24 * 60 * 60 * 1000).toISOString();
  const anterior = await obterRelatorioDecisoes();

  const resumos = [];
  const contadores = {};
  const plataformas = filtrarPlataformas(await listarPlataformas()).filter((p) => p.ativa !== false);

  for (const plataforma of plataformas) {
    const moeda = plataforma.moeda ?? 'BRL';
    let ativos = [];
    try {
      ativos = await listarAtivos(plataforma.id);
    } catch (e) {
      log.aviso(`relatório: não foi possível listar os ativos de ${plataforma.id}`, e);
      continue;
    }
    for (const ativo of ativos) {
      try {
        const operacoes = await obterOperacoesDesdeAtivo(plataforma.id, ativo.id, inicio);
        // Só os lotes citados nas vendas da janela — nunca a coleção inteira.
        const ids = new Set();
        for (const op of operacoes) {
          if (op.tipo === 'VENDA' && op.status === 'executada') for (const id of op.posicoes ?? []) ids.add(id);
        }
        const posicoesPorId = new Map();
        for (const id of ids) {
          const pos = await obterPosicaoAtivo(plataforma.id, ativo.id, id);
          if (pos) posicoesPorId.set(id, pos);
        }
        resumos.push(resumirOperacoes({ operacoes, posicoesPorId, moeda }));

        const estado = await obterEstadoAtivo(plataforma.id, ativo.id);
        const c = estado?.decisoes_acumuladas;
        if (c) {
          for (const acao of ['COMPRAR', 'VENDER', 'AGUARDAR']) {
            contadores[acao] = (contadores[acao] ?? 0) + (Number(c[acao]) || 0);
          }
        }
      } catch (e) {
        log.aviso(`relatório: falha ao resumir ${plataforma.id}/${ativo.id} — seguindo`, e);
      }
    }
  }

  const relatorio = {
    ...consolidar(resumos),
    gerado_em: fim,
    janela: { inicio, fim, dias },
    decisoes: deltaDecisoes(contadores, anterior?.contadores_decisoes ?? {}),
    contadores_decisoes: contadores, // retrato para o delta do próximo relatório
  };
  await salvarRelatorioDecisoes(relatorio);
  return relatorio;
}
