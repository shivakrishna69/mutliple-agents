/**
 * Renders a chat message's text with the one piece of markdown the AI commonly writes: **bold**.
 *
 * Safety: the text is never parsed as HTML. It is split on **...** markers and every piece is
 * rendered as a React text node (escaped), with bold pieces wrapped in <strong>. No
 * dangerouslySetInnerHTML, so a message containing HTML or script shows as literal text.
 * Line breaks and numbered lists are preserved by the bubble's `whitespace-pre-wrap`.
 */

// **text** where text is non-empty, does not start or end with whitespace, and contains no "**".
const BOLD_MARKDOWN_PATTERN = /\*\*(?=\S)((?:(?!\*\*)[\s\S])*?\S)\*\*/g;

export default function MessageText({ text }) {
  const textSegments = [];
  let previousEndIndex = 0;
  for (const boldMatch of text.matchAll(BOLD_MARKDOWN_PATTERN)) {
    if (boldMatch.index > previousEndIndex) {
      textSegments.push({ isBold: false, value: text.slice(previousEndIndex, boldMatch.index) });
    }
    textSegments.push({ isBold: true, value: boldMatch[1] });
    previousEndIndex = boldMatch.index + boldMatch[0].length;
  }
  if (previousEndIndex < text.length) {
    textSegments.push({ isBold: false, value: text.slice(previousEndIndex) });
  }

  return textSegments.map((textSegment, segmentIndex) =>
    textSegment.isBold ? <strong key={segmentIndex} className="font-semibold">{textSegment.value}</strong> : textSegment.value,
  );
}
