/** Reader-friendly stylesheet tuned for e-ink devices (Kobo honours most of it). */
export const EPUB_STYLESHEET = `
@charset "UTF-8";
html { font-size: 100%; }
body {
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.5;
  margin: 0 0.5em;
  text-align: left;
  -webkit-hyphens: auto; hyphens: auto;
  widows: 2; orphans: 2;
}
h1, h2, h3, h4, h5, h6 {
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.25;
  margin: 1.4em 0 0.6em 0;
  page-break-after: avoid;
  -webkit-hyphens: none; hyphens: none;
}
h1 { font-size: 1.7em; margin-top: 0.6em; }
h2 { font-size: 1.35em; }
h3 { font-size: 1.15em; }
h4, h5, h6 { font-size: 1em; }
p { margin: 0 0 0.9em 0; }
.article-header { margin-bottom: 1.5em; }
.article-header .subtitle { font-style: italic; font-size: 1.1em; color: #333; }
.article-header .byline, .article-header .dateline, .article-header .source { font-size: 0.9em; color: #444; margin: 0.2em 0; }
.article-footer { margin-top: 2.5em; font-size: 0.85em; color: #444; }
blockquote { margin: 1em 1.2em; padding-left: 0.8em; border-left: 3px solid #999; font-style: italic; }
blockquote blockquote { font-style: normal; }
.pullquote { margin: 1.4em 0.8em; font-size: 1.15em; font-style: italic; text-align: center; }
pre { white-space: pre-wrap; word-wrap: break-word; font-family: "Courier New", monospace; font-size: 0.85em; background: #f3f3f3; padding: 0.6em; margin: 1em 0; }
code { font-family: "Courier New", monospace; font-size: 0.9em; }
figure { margin: 1.2em 0; text-align: center; page-break-inside: avoid; }
figure img, img { max-width: 100%; height: auto; }
figcaption { font-size: 0.85em; color: #444; margin-top: 0.4em; text-align: center; }
ul, ol { margin: 0.8em 0 0.8em 1.2em; padding-left: 0.8em; }
li { margin-bottom: 0.3em; }
hr { border: 0; border-top: 1px solid #999; margin: 1.6em 2em; }
table { border-collapse: collapse; margin: 1em 0; width: 100%; font-size: 0.9em; }
th, td { border: 1px solid #999; padding: 0.3em 0.5em; vertical-align: top; }
a { color: inherit; text-decoration: underline; }
sup, sub { font-size: 0.75em; line-height: 0; }
.footnote { font-size: 0.9em; margin: 0.6em 0; }
.cover { text-align: center; margin: 0; padding: 0; }
.cover img { max-height: 100%; max-width: 100%; }
nav#toc ol { list-style: none; margin-left: 0; padding-left: 0; }
nav#toc ol ol { padding-left: 1.2em; }
nav#toc li { margin: 0.4em 0; }
`.trim();
