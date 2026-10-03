export interface HtmlLink {
  url: string;
  label: string;
}

const BLOCK_ELEMENTS = ["br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"];

export async function htmlToTextAndLinks(html: string): Promise<{ text: string; links: HtmlLink[] }> {
  const textParts: string[] = [];
  const links: HtmlLink[] = [];
  const rewriter = new HTMLRewriter();
  let suppressedDepth = 0;

  for (const selector of ["script", "style", "head", "template"]) {
    rewriter.on(selector, {
      element(element) {
        suppressedDepth += 1;
        element.onEndTag(() => { suppressedDepth -= 1; });
        element.remove();
      },
    });
  }
  for (const selector of BLOCK_ELEMENTS) {
    rewriter.on(selector, {
      element(element) {
        textParts.push("\n");
        if (selector !== "br") element.onEndTag(() => { textParts.push("\n"); });
      },
    });
  }
  rewriter.onDocument({
    text(text) {
      if (suppressedDepth === 0) textParts.push(text.text);
    },
  });
  let currentLink: { url: string; labelParts: string[] } | null = null;
  rewriter.on("a[href]", {
    element(element) {
      currentLink = { url: element.getAttribute("href") ?? "", labelParts: [] };
      element.onEndTag(() => {
        if (currentLink) links.push({ url: currentLink.url, label: currentLink.labelParts.join("").trim() });
        currentLink = null;
      });
    },
    text(text) {
      currentLink?.labelParts.push(text.text);
    },
  });

  const response = rewriter.transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  await response.arrayBuffer();
  const text = textParts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, links };
}
