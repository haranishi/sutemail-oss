/* 全アプリ共通のシェア機能。ここが正本で、各アプリの shared/ へは
   `npm run shared:sync` が複製する（アプリを1フォルダで完結させたままにするため）。

   置き場所は自分で決める：#share があればそこ、無ければ <footer> の末尾、それも無ければ <body> の末尾。
   だから各アプリ側の作業は index.html に1行足すだけで済む。

   ■ Instagram と YouTube について
   この2つには「Webから投稿画面を開く」公式の仕組み（intent URL）が無い。
   ボタンを置いてもアプリのトップページが開くだけで、リンクは何も渡らない。
   なので端末の共有シート（navigator.share）とリンクのコピーで渡す形にしてある。
   共有シートには Instagram も YouTube も並ぶ（その端末に入っていれば）。 */

(function () {
const INTENT = {
  // 本文とURLを載せた投稿画面がそのまま開く
  x: (text, url) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
  line: (text, url) => `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}`,
};

function shareUrl() {
  // 公開URLは build が <link rel="canonical"> として埋める。手元で開いた時は今いるURL
  const canonical = document.querySelector('link[rel="canonical"]')?.href;
  return canonical || location.href;
}

function shareText() {
  const declared = document.querySelector('meta[name="share:text"]')?.content?.trim();
  if (declared) return declared;
  // <title> の「 | 100日チャレンジ …」以降は共有文には要らない
  return (document.title || '').split('|')[0].trim() || document.title;
}

function button(label, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = `share__button ${className}`.trim();
  node.textContent = label;
  return node;
}

function link(label, href, className = '') {
  const node = document.createElement('a');
  node.className = `share__button ${className}`.trim();
  node.href = href;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  node.textContent = label;
  return node;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // クリップボードAPIが使えない環境（古いSafari・http接続など）向けの逃げ道
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function mountShare(host) {
  const url = shareUrl();
  const text = shareText();
  const target = host || document.getElementById('share') || document.querySelector('footer') || document.body;
  if (target.querySelector('.share')) return null; // 二重に据え付けない

  const box = document.createElement('section');
  box.className = 'share';
  box.setAttribute('aria-labelledby', 'share-label');

  const label = document.createElement('h2');
  label.className = 'share__label';
  label.id = 'share-label';
  label.textContent = 'このアプリを共有する';
  box.append(label);

  const row = document.createElement('div');
  row.className = 'share__row';

  // 端末の共有シート。Instagram・YouTube・LINE・メールなど、入っているアプリがここに並ぶ
  if (navigator.share) {
    const native = button('共有…', 'share__button--primary');
    native.addEventListener('click', async () => {
      try {
        await navigator.share({ title: text, text, url });
      } catch {
        // 利用者が閉じただけ。何も出さない
      }
    });
    row.append(native);
  }

  row.append(link('Xで投稿', INTENT.x(text, url)), link('LINEで送る', INTENT.line(text, url)));

  const copyButton = button('リンクをコピー');
  const said = document.createElement('span');
  said.className = 'share__said';
  said.setAttribute('role', 'status');
  said.setAttribute('aria-live', 'polite');
  copyButton.addEventListener('click', async () => {
    const ok = await copy(url);
    said.textContent = ok ? 'コピーしました' : 'コピーできませんでした。URLを選んでコピーしてください';
    copyButton.dataset.done = String(ok);
    setTimeout(() => {
      said.textContent = '';
      delete copyButton.dataset.done;
    }, 4000);
  });
  row.append(copyButton);
  box.append(row, said);

  const note = document.createElement('p');
  note.className = 'share__note';
  note.textContent = navigator.share
    ? 'InstagramとYouTubeはWebから直接投稿できない仕組みなので、「共有…」かコピーしたリンクから貼ってください。'
    : 'InstagramとYouTubeはWebから直接投稿できない仕組みなので、リンクをコピーして貼ってください。';
  box.append(note);

  target.append(box);
  return box;
}

// 読み込むだけで据え付く（各アプリ側で呼び出しを書かなくていい）。
// ESモジュールにすると file:// で開いたときに読み込みごと失敗するので、通常スクリプトにしてある
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { mountShare(); });
} else {
  mountShare();
}
})();
