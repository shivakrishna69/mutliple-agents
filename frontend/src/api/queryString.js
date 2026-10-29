/** "?a=1&b=2" from the parameters that have a value (undefined, null and "" are left out); "" when none do. */
export function toQueryString(queryParameters) {
  const searchParameters = new URLSearchParams();
  for (const [parameterName, parameterValue] of Object.entries(queryParameters)) {
    if (parameterValue !== undefined && parameterValue !== null && parameterValue !== '')
      searchParameters.set(parameterName, String(parameterValue));
  }
  const queryString = searchParameters.toString();
  return queryString ? `?${queryString}` : '';
}
