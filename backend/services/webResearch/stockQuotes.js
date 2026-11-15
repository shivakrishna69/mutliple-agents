/**
 * NSE and BSE stock quotes for NSK. A quote provider is an object with
 *
 *   name                          shown in the citation ("Alpha Vantage")
 *   getQuote(symbol, exchange)    → the quote, or null when it has no data for the symbol; throws
 *                                 QuoteProviderError('rate_limited' | 'unavailable')
 *
 * so another market data source can be added without touching the tool. The one included is Alpha
 * Vantage's GLOBAL_QUOTE (end-of-day on its free tier): BSE symbols are "<SYMBOL>.BSE" (documented);
 * NSE symbols are asked as "<SYMBOL>.NSE" and, when it has none, answered by the fallback.
 *
 * getStockQuote() answers { kind: 'quote', quote } or, when there is no provider, the provider's limit
 * is used up, it has no data, or it fails, { kind: 'search_fallback', reason, results }: web search
 * snippets for "<symbol> share price <exchange>", clearly labelled as unverified.
 */

import { WEB_RESEARCH_SETTINGS as S } from '../../constants/validation.js';
import { logger } from '../../utils/logger.js';
import { searchWeb } from './webSearch.js';

export class QuoteProviderError extends Error {
  /** @param {'rate_limited'|'unavailable'} reason */
  constructor(reason) {
    super(reason);
    this.name = 'QuoteProviderError';
    this.reason = reason;
  }
}

export const FALLBACK_REASONS = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  RATE_LIMITED: 'rate_limited',
  NO_DATA: 'no_data',
  UNAVAILABLE: 'unavailable',
});

const number = (value) => {
  const parsed = Number.parseFloat(String(value ?? '').replace('%', ''));
  return Number.isFinite(parsed) ? parsed : null;
};

/** Alpha Vantage GLOBAL_QUOTE. Its free tier answers {"Information": …} (formerly "Note") when used up. */
export function alphaVantageProvider({ apiKey, baseUrl }, { fetchImpl = fetch } = {}) {
  return {
    name: 'Alpha Vantage',
    async getQuote(symbol, exchange) {
      const params = new URLSearchParams({ function: 'GLOBAL_QUOTE', symbol: `${symbol}.${exchange}`, apikey: apiKey });
      let body;
      try {
        const response = await fetchImpl(`${baseUrl}/query?${params}`, {
          signal: AbortSignal.timeout(S.PROVIDER_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Alpha Vantage answered ${response.status}`);
        body = await response.json();
      } catch (providerError) {
        logger.warn('Stock quote provider failed', {
          error: { name: providerError.name, message: providerError.message },
        });
        throw new QuoteProviderError(FALLBACK_REASONS.UNAVAILABLE);
      }
      if (typeof body?.Information === 'string' || typeof body?.Note === 'string') {
        throw new QuoteProviderError(FALLBACK_REASONS.RATE_LIMITED);
      }
      if (typeof body?.['Error Message'] === 'string') return null;
      const quote = body?.['Global Quote'];
      const price = number(quote?.['05. price']);
      if (!quote || price === null) return null;
      return {
        symbol,
        exchange,
        price,
        currency: 'INR',
        open: number(quote['02. open']),
        high: number(quote['03. high']),
        low: number(quote['04. low']),
        previousClose: number(quote['08. previous close']),
        change: number(quote['09. change']),
        changePercent: number(quote['10. change percent']),
        volume: number(quote['06. volume']),
        latestTradingDay: typeof quote['07. latest trading day'] === 'string' ? quote['07. latest trading day'] : null,
      };
    },
  };
}

/** The provider this server is configured with, or null. */
export function quoteProviderFor(config) {
  return config.webResearch.alphaVantage ? alphaVantageProvider(config.webResearch.alphaVantage) : null;
}

/**
 * @param {{ symbol: string, exchange: 'NSE'|'BSE', config: object, settings: object, provider?: object|null }} request
 */
export async function getStockQuote({ symbol, exchange, config, settings, provider = quoteProviderFor(config) }) {
  let reason = FALLBACK_REASONS.NOT_CONFIGURED;
  if (provider) {
    try {
      const quote = await provider.getQuote(symbol, exchange);
      if (quote) return { kind: 'quote', provider: provider.name, quote };
      reason = FALLBACK_REASONS.NO_DATA;
    } catch (providerError) {
      if (!(providerError instanceof QuoteProviderError)) throw providerError;
      reason = providerError.reason;
    }
  }
  const results = await searchWeb({ query: `${symbol} share price ${exchange}`, config, settings });
  return { kind: 'search_fallback', reason, results };
}
