// orcamentos.js — a soma dos orçamentos por plataforma E por modo (V8.16).
//
// Módulo PURO, sem DOM e sem Firebase, pelo mesmo motivo do `limiteLogin.js`:
// esta conta é a única da dashboard que decide algo visível (o vermelho de
// "passou de 100%"), e ela já sumiu uma vez ao mudar de tela. Aqui ela tem
// teste (`tests/orcamentos.test.js`); a tela só desenha o que este arquivo
// devolve.
//
// POR QUE POR MODO, e não da plataforma inteira: simulação e real têm
// patrimônios separados, e cada um divide os SEUS próprios 100%. O orçamento de
// um ativo real é fatia do dinheiro real; o de um simulado é fatia da carteira
// virtual. Somar os dois grupos dava um número sem significado — a Binance
// mostrava 205% com os reais somando exatamente os 100% certos, e o aviso
// vermelho pedia um reequilíbrio que não existia.

/** Acima disto o grupo aparece em vermelho. Aviso, nunca trava. */
export const TETO_ORCAMENTO = 100;

const arredondar = (v) => Math.round(v * 100) / 100;

/**
 * Soma os orçamentos de cada (plataforma × modo).
 *
 * @param {object} p
 *   plataformas — Map(pid → { dados, ativos: Map(aid → { config }) })
 *   valorEditado — (pid, aid, coluna, salvo) => valor. Devolve o que está sendo
 *     DIGITADO na tabela quando houver, e o valor salvo quando não houver. É o
 *     que faz a soma reagir antes de salvar — inclusive quando o que mudou foi
 *     a chave "simulação", que move o ativo de um grupo para o outro.
 * @returns {Array<{ pid, nome, modo, rotuloModo, total, quantos, excedeu, ativos }>}
 *   Uma linha por grupo NÃO VAZIO, na ordem das plataformas; dentro de cada
 *   uma, real antes de simulação. `ativos` são os ids daquele grupo — é com eles
 *   que a tela pinta as células do orçamento que entraram na conta.
 */
export function somarOrcamentos({ plataformas, valorEditado = (_p, _a, _c, salvo) => salvo }) {
  const linhas = [];
  for (const [pid, plataforma] of plataformas) {
    const soma = { simulacao: 0, real: 0 };
    const ativos = { simulacao: [], real: [] };

    for (const [aid, ativo] of plataforma.ativos ?? []) {
      // O modo é o do FORMULÁRIO, não o que está salvo: quem está movendo um
      // ativo de simulação para real precisa ver na hora a soma do grupo para
      // onde ele vai.
      const simulacao = valorEditado(pid, aid, 'modo_simulacao', ativo.config?.modo_simulacao !== false);
      const modo = simulacao ? 'simulacao' : 'real';
      const bruto = Number(valorEditado(pid, aid, 'orcamento_percentual', ativo.config?.orcamento_percentual ?? 0));
      // Campo vazio (NaN) conta como 0: enquanto se apaga um número para
      // digitar outro, o total não pode virar "NaN%" na tela.
      soma[modo] += Number.isFinite(bruto) ? bruto : 0;
      ativos[modo].push(aid);
    }

    for (const modo of ['real', 'simulacao']) {
      if (ativos[modo].length === 0) continue;
      const total = arredondar(soma[modo]);
      linhas.push({
        pid,
        nome: plataforma.dados?.nome || pid,
        modo,
        rotuloModo: modo === 'real' ? 'MODO REAL' : 'SIMULAÇÃO',
        total,
        quantos: ativos[modo].length,
        excedeu: total > TETO_ORCAMENTO,
        ativos: ativos[modo],
      });
    }
  }
  return linhas;
}

/** A frase que a tela mostra para um grupo. */
export function textoOrcamento(linha) {
  const contagem = linha.quantos === 1 ? '1 ativo' : `${linha.quantos} ativos`;
  const cabeca = `${linha.nome} · ${linha.rotuloModo} (${contagem})`;
  return linha.excedeu
    ? `${cabeca}: ${linha.total}% — ACIMA DE 100%, reequilibre entre os ativos deste modo`
    : `${cabeca}: ${linha.total}% de 100%`;
}
