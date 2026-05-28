const copyButton = document.querySelector('[data-copy-md]');
const copyStatus = document.querySelector('[data-copy-status]');
const rawLink = document.querySelector('[data-md-url]');
const fallback = document.querySelector('[data-md-fallback]');

async function getMarkdown() {
  let markdown = fallback ? fallback.value.trim() : '';

  if (!rawLink) {
    return markdown;
  }

  try {
    const response = await fetch(rawLink.getAttribute('href'), { cache: 'no-store' });
    if (response.ok) {
      markdown = (await response.text()).trim();
    }
  } catch (error) {
    markdown = markdown.trim();
  }

  return markdown;
}

copyButton.addEventListener('click', async () => {
  const markdown = await getMarkdown();

  try {
    await navigator.clipboard.writeText(`${markdown}\n`);
    copyStatus.textContent = 'copied';
  } catch (error) {
    copyStatus.textContent = 'select text below';
    if (fallback) {
      fallback.focus();
      fallback.select();
    }
  }
});
