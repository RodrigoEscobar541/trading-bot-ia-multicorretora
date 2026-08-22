#!/usr/bin/env node
// publicar-regras.mjs — sobe as SEMENTES de prompt do repositório para os docs
// que a IA realmente lê (`global/regras_gerais` e `global/regras_gerais_venda`).
//
// POR QUE PRECISA EXISTIR: os arquivos `.md/` são só semente — depois da
// primeira inicialização a fonte de verdade é o Firestore, e editar o .md não
// muda nada no que a IA recebe. Sem isto, a V8.8 mexeria no Motor e deixaria o
// prompt ensinando a regra antiga.
//
// USO:
//   node publicar-regras.mjs                    # mostra o que faria (diff resumido)
//   node publicar-regras.mjs --executar         # grava, incrementando a versão
//   node publicar-regras.mjs BTC --executar     # SÓ os docs cujo caminho casa
//
// O filtro por trecho de caminho existe porque o banco e o repositório podem
// divergir de propósito: um texto editado pela dashboard é mais novo que a
// semente, e publicar tudo o apagaria sem querer.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync } from 'node:fs';

const EXECUTAR = process.argv.includes('--executar');
const FILTROS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CHAVE = './seu-projeto-firebase-adminsdk.json';

initializeApp({ credential: cert(JSON.parse(readFileSync(CHAVE, 'utf8'))) });
const db = getFirestore();

// Qualquer doc de TEXTO que a IA lê e que tenha semente no repositório: as
// regras gerais (globais) e os prompts de ATIVO — estes últimos vivem um por
// (plataforma, ativo), e o mesmo arquivo alimenta os dois quando o ativo é o
// mesmo em corretoras diferentes (BTC no MB e na Binance).
const DOCS = [
  { caminho: 'global/regras_gerais', semente: '.md/regras_gerais.md' },
  { caminho: 'global/regras_gerais_venda', semente: '.md/regras_gerais_venda.md' },
  // Template da TORO (V8.16): a plataforma passou a ter `usaRegrasGerais: false`,
  // então este texto é a PRIMEIRA camada do prompt dela — e por isso precisa
  // ser autossuficiente, como o da Steam.
  { caminho: 'plataformas/TORO/dados/template', semente: '.md/AgenteIA_Toro_AcoesBR.md' },
  { caminho: 'plataformas/MB/ativos/BTC/dados/prompt', semente: '.md/Ativo_BTC.md' },
  { caminho: 'plataformas/BN/ativos/BTC/dados/prompt', semente: '.md/Ativo_BTC.md' },
  // Prompts dos ativos da TORO (V8.16). Os números de amplitude e liquidez
  // deles são MEDIDOS (3 meses de candles diários da brapi), não de memória —
  // refazer a medição antes de reescrever qualquer um destes textos.
  { caminho: 'plataformas/TORO/ativos/FIIR11/dados/prompt', semente: '.md/Ativo_FIIR11.md' },
  { caminho: 'plataformas/TORO/ativos/ETFD11/dados/prompt', semente: '.md/Ativo_ETFD11.md' },
  { caminho: 'plataformas/TORO/ativos/BDRT34/dados/prompt', semente: '.md/Ativo_BDRT34.md' },
  { caminho: 'plataformas/TORO/ativos/ETFG11/dados/prompt', semente: '.md/Ativo_ETFG11.md' },
];

for (const { caminho, semente } of DOCS) {
  if (FILTROS.length > 0 && !FILTROS.some((f) => caminho.includes(f))) continue;
  const doc = caminho.replace(/\//g, '_');
  const conteudo = readFileSync(semente, 'utf8');
  const ref = db.doc(caminho);
  const atual = (await ref.get()).data() || {};

  if ((atual.conteudo ?? '') === conteudo) {
    console.log(`= ${doc}: já idêntico ao ${semente} (versão ${atual.versao ?? '?'}) — nada a fazer`);
    continue;
  }

  console.log(`~ ${doc}: versão ${atual.versao ?? 0} → ${(atual.versao ?? 0) + 1}`);
  console.log(`  banco: ${(atual.conteudo ?? '').length} caracteres | ${semente}: ${conteudo.length}`);

  if (!EXECUTAR) {
    console.log('  (simulação — use --executar para gravar)');
    continue;
  }

  // Backup do texto que está no ar, para poder voltar sem depender do git.
  const backup = `backup_${doc}_${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  writeFileSync(backup, atual.conteudo ?? '');
  console.log(`  backup do texto atual em ${backup}`);

  await ref.set(
    { conteudo, versao: (atual.versao ?? 0) + 1, atualizado_em: new Date().toISOString() },
    { merge: true },
  );
  console.log('  GRAVADO');
}

console.log(
  EXECUTAR
    ? '\nPronto. O bot lê o prompt pelo catálogo cacheado: a mudança vale em até 5 minutos.'
    : '\nNada foi gravado.',
);
process.exit(0);
