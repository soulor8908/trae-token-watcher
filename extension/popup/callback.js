// OAuth 回调页 — 从 URL fragment 接收 token，存入 chrome.storage 后关闭
// fragment 格式：#token=xxx&expires=xxx&login=xxx&avatar=xxx&starred=1
(function () {
  const msg = document.getElementById('msg');
  const spinner = document.getElementById('spinner');

  try {
    const hash = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const token = params.get('token');
    const expires = parseInt(params.get('expires') || '0', 10);
    const login = params.get('login') || '';
    const avatar = params.get('avatar') || '';
    const starred = params.get('starred') === '1';

    if (!token) {
      spinner.style.display = 'none';
      msg.className = 'msg err';
      msg.textContent = '登录失败：未收到 token';
      return;
    }

    chrome.storage.local.set(
      {
        ttw_session: { token, expires, login, avatar, starred },
      },
      () => {
        spinner.style.display = 'none';
        msg.className = 'msg ok';
        msg.textContent = starred
          ? `已登录：${login}（已 Star）`
          : `已登录：${login}（未 Star，诊断功能需先 Star 仓库）`;
        // 1.5 秒后自动关闭标签页
        setTimeout(() => window.close(), 1500);
      }
    );
  } catch (e) {
    spinner.style.display = 'none';
    msg.className = 'msg err';
    msg.textContent = '登录失败：' + (e.message || '未知错误');
  }
})();
