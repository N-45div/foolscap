import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Markdown → sanitized HTML. Session text is untrusted (it can contain
 * anything a web page or tool output contained), so DOMPurify runs over
 * every render — markdown alone is not a sanitizer.
 */

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "button"],
    ADD_ATTR: ["target", "rel"],
  });
}

/** Open links from transcripts in a new tab, never in the viewer. */
function hardenLinks(html: string): string {
  return html.replaceAll(
    "<a ",
    '<a target="_blank" rel="noopener noreferrer" ',
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div
      className="md max-w-[80ch] py-2 text-sm leading-relaxed"
      // Sanitized above — this is the only place innerHTML is used.
      dangerouslySetInnerHTML={{ __html: hardenLinks(renderMarkdown(text)) }}
    />
  );
}

export function markdownForExport(text: string): string {
  return hardenLinks(renderMarkdown(text));
}
