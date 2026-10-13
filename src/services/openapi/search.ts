import { schemaClosure, type SimplifiedApi, type TypeExpr } from "./simplify.js";

/**
 * Lexical ranking of operations against words pulled from a design (visible
 * text, layer names). There are no explicit design→API annotations, so this is
 * deliberately a recall tool: it narrows hundreds of operations down to a short
 * list with reasons, and the LLM makes the final call. Not embeddings — that
 * would need a model/service dependency, and lexical hits on summaries and
 * field names already carry most of the signal in real specs.
 */

type FieldKind = "summary" | "tag" | "id" | "path" | "field" | "desc";

const WEIGHTS: Record<FieldKind, number> = {
  summary: 5,
  tag: 4,
  id: 3,
  path: 3,
  field: 2,
  desc: 1,
};

// Page designs mostly display data, so read endpoints are the likelier match
// when scores are otherwise close.
const GET_BOOST = 1.1;

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "your", "this", "that", "all"]);

const CJK_RUN = /[㐀-鿿豈-﫿]+/g;

type Field = { kind: FieldKind; text: string; words: Set<string> };

export type SearchIndex = Map<string, Field[]>;

export type SearchHit = { id: string; score: number; matched: string[] };

export function buildSearchIndex(api: SimplifiedApi): SearchIndex {
  const index: SearchIndex = new Map();
  for (const op of api.operations) {
    const fields: Field[] = [];
    const add = (kind: FieldKind, text: string | undefined) => {
      if (text) fields.push({ kind, text: text.toLowerCase(), words: new Set(splitWords(text)) });
    };

    add("summary", op.summary);
    add("desc", op.description);
    op.tags?.forEach((tag) => add("tag", tag));
    add("id", op.id);
    add("path", op.path.replace(/\{[^}]*\}/g, " "));

    const walk = (expr: TypeExpr | undefined) => {
      if (expr === undefined) return;
      if (typeof expr === "string") {
        const [type, note] = expr.split("  # ");
        // Enum literals ("PAID" | "待支付") match status chips and tabs in designs.
        if (type.includes('"')) add("desc", type);
        add("desc", note);
        return;
      }
      if (Array.isArray(expr)) return expr.forEach(walk);
      for (const [key, value] of Object.entries(expr)) {
        if (key === "#") {
          add("desc", value as string);
          continue;
        }
        add("field", key.replace(/\?$/, ""));
        walk(value);
      }
    };

    Object.values(op.params ?? {}).forEach((group) => walk(group));
    walk(op.body);
    walk(op.response);
    for (const name of schemaClosure(api, api.operationRefs.get(op.id) ?? [])) {
      walk(api.schemas[name]);
    }

    index.set(op.id, fields);
  }
  return index;
}

export function searchOperations(
  api: SimplifiedApi,
  index: SearchIndex,
  candidateIds: Iterable<string>,
  keywords: string[],
): SearchHit[] {
  const terms = [...new Set(keywords.flatMap(extractTerms))];
  if (terms.length === 0) return [];
  const methods = new Map(api.operations.map((op) => [op.id, op.method]));

  const hits: SearchHit[] = [];
  for (const id of candidateIds) {
    const fields = index.get(id) ?? [];
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      let best = 0;
      let bestKind: FieldKind | undefined;
      for (const field of fields) {
        const strength = WEIGHTS[field.kind] * matchStrength(term, field);
        if (strength > best) {
          best = strength;
          bestKind = field.kind;
        }
      }
      if (bestKind) {
        score += best;
        matched.push(`${term}(${bestKind})`);
      }
    }
    if (score > 0) {
      if (methods.get(id) === "GET") score *= GET_BOOST;
      hits.push({ id, score: Math.round(score * 10) / 10, matched });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

/**
 * Turn a free-form keyword (often raw design text like "订单编号：202501" or
 * "OrderCard") into match terms: CJK runs of 2+ chars, and lowercase ASCII
 * words of 3+ chars. Symbols are dropped; digit runs of 3+ are kept on purpose,
 * since a placeholder like "202501020001" can hit a field's `example`.
 */
function extractTerms(keyword: string): string[] {
  const cjk = keyword.match(CJK_RUN)?.filter((run) => run.length >= 2) ?? [];
  const ascii = splitWords(keyword.replace(CJK_RUN, " ")).filter(
    (w) => w.length >= 3 && !STOPWORDS.has(w),
  );
  return [...cjk, ...ascii];
}

/** `orderNo`, `order_no`, `Order-No` → ["order", "no"]. */
function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** 0..1: how well a term matches a field. */
function matchStrength(term: string, field: Field): number {
  if (/^[a-z0-9]+$/.test(term)) {
    if (field.words.has(term)) return 1;
    // Cheap stemming: order/orders, pay/payment. Only for 4+ chars to avoid
    // short words prefix-matching everything.
    for (const word of field.words) {
      if (
        word.length >= 4 &&
        term.length >= 4 &&
        (word.startsWith(term) || term.startsWith(word))
      ) {
        return 0.8;
      }
    }
    return 0;
  }

  if (field.text.includes(term)) return 1;
  // Chinese has no word boundaries and design copy rarely matches spec wording
  // exactly ("订单编号" vs "订单号"), so fall back to character-bigram overlap.
  if (term.length <= 2) return 0;
  let hits = 0;
  for (let i = 0; i < term.length - 1; i++) {
    if (field.text.includes(term.slice(i, i + 2))) hits++;
  }
  const ratio = hits / (term.length - 1);
  return ratio >= 0.3 ? ratio * 0.6 : 0;
}
