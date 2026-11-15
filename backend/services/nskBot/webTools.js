/**
 * NSK's web research tools (nskTools.js registers them), on services/webResearch/:
 *
 *   web_search                 SearXNG results for a query                              RUN_WEB_RESEARCH
 *   fetch_web_page             one page, read safely and kept as external knowledge     RUN_WEB_RESEARCH
 *   get_stock_quote            an NSE or BSE quote, or search snippets when the quote   RUN_WEB_RESEARCH
 *                              provider cannot answer
 *   external_knowledge_scope   what the ai-service may search in `external_knowledge`   everyone
 *                              for this person: approved pages only, or also the pages
 *                              read for people with live research
 *
 * The live tools spend the person's daily limits and answer with an `audit` (what was looked up:
 * the domain of a page, the length of a query, the symbol), recorded by the controller; never a
 * query's text or a page's content.
 */

import { CAPABILITIES, hasCapability } from '../../constants/accessRoles.js';
import { NSK_BOT_MESSAGES, WEB_RESEARCH_MESSAGES } from '../../constants/messages.js';
import { WEB_RESEARCH_SETTINGS as S } from '../../constants/validation.js';
import { readOfficeLocalClock } from '../attendancePolicy.js';
import { getCompanySettings } from '../companySettings.js';
import { USAGE_KINDS, readPage, reserveWebUsage, toPageResult } from '../webResearch/externalKnowledge.js';
import { getStockQuote } from '../webResearch/stockQuotes.js';
import { getWebResearchSettings } from '../webResearch/webResearchSettings.js';
import { searchWeb } from '../webResearch/webSearch.js';

const LABELS = NSK_BOT_MESSAGES.SOURCE_LABELS;
export const WEB_AUDIT_ACTION = 'nsk_web_research';

async function companyToday(now) {
  const { timeZone } = await getCompanySettings();
  return readOfficeLocalClock(now, timeZone).calendarDate;
}

/** @param {{ actor, input: { query: string }, config, now }} call */
export async function webSearchTool({ actor, input, config, now }) {
  const settings = await getWebResearchSettings();
  await reserveWebUsage(USAGE_KINDS.SEARCH, actor, config);
  const results = await searchWeb({ query: input.query, config, settings });
  return {
    result: { query: input.query, results },
    source: LABELS.WEB_SEARCH(input.query, await companyToday(now)),
    audit: {
      action: WEB_AUDIT_ACTION,
      details: { kind: 'search', queryLength: input.query.length, results: results.length },
    },
  };
}

/** @param {{ actor, input: { url: string }, config, requestId, now }} call */
export async function fetchWebPageTool({ actor, input, config, requestId, now }) {
  const settings = await getWebResearchSettings();
  const { source, cached, note } = await readPage({ actor, url: input.url, settings, config, requestId, now });
  return {
    result: toPageResult(source, { cached, note }),
    source: LABELS.WEB_PAGE(source.title, source.domain, source.fetchedAt.toISOString().slice(0, 10)),
    audit: {
      action: WEB_AUDIT_ACTION,
      details: {
        kind: 'fetch',
        domain: source.domain,
        sourceId: source._id.toString(),
        cached,
        approved: source.approved,
      },
    },
  };
}

/** @param {{ actor, input: { symbol: string, exchange: string }, config, now }} call */
export async function stockQuoteTool({ actor, input, config, now }) {
  const settings = await getWebResearchSettings();
  await reserveWebUsage(USAGE_KINDS.QUOTE, actor, config);
  const answer = await getStockQuote({ symbol: input.symbol, exchange: input.exchange, config, settings });
  const audit = {
    action: WEB_AUDIT_ACTION,
    details: { kind: 'quote', symbol: input.symbol, exchange: input.exchange, answered: answer.kind },
  };
  if (answer.kind === 'quote') {
    const { quote } = answer;
    return {
      result: { kind: answer.kind, provider: answer.provider, note: WEB_RESEARCH_MESSAGES.QUOTE_NOTE, quote },
      source: LABELS.STOCK_QUOTE(quote.symbol, quote.exchange, quote.latestTradingDay ?? (await companyToday(now))),
      audit,
    };
  }
  const query = `${input.symbol} share price ${input.exchange}`;
  return {
    result: {
      kind: answer.kind,
      note: WEB_RESEARCH_MESSAGES.QUOTE_FALLBACK_NOTE(WEB_RESEARCH_MESSAGES.QUOTE_FALLBACK_REASONS[answer.reason]),
      results: answer.results,
    },
    source: LABELS.WEB_SEARCH(query, await companyToday(now)),
    audit,
  };
}

/** @param {{ actor }} call */
export async function externalKnowledgeScopeTool({ actor }) {
  const includeUnapproved = hasCapability(actor.role, CAPABILITIES.RUN_WEB_RESEARCH);
  return {
    result: {
      include_unapproved: includeUnapproved,
      ...(includeUnapproved ? {} : { note: WEB_RESEARCH_MESSAGES.CACHED_ONLY_NOTE }),
    },
    source: null,
  };
}

export const WEB_ARGUMENT_LIMITS = Object.freeze({
  QUERY_MIN_LENGTH: 2,
  QUERY_MAX_LENGTH: S.SEARCH_QUERY_MAX_LENGTH,
  URL_MAX_LENGTH: S.URL_MAX_LENGTH,
});
