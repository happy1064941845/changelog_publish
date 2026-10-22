async function main({ params }) {
  // ============================================================
  // 工作流 B · 节点六「核对写入结果」
  //
  // 为什么需要这个节点：
  //   节点三（渲染代码）在【发 PUT 请求之前】就把「已写入 vX，共 N 条…」
  //   这条消息拼好并输出了。也就是说——那条消息是"预测"，不是"事实"。
  //   真正的结果只存在于节点五（HTTP 写）的响应里。
  //   如果链路里没有一环回头看那个响应，PUT 失败时（403/409/422…）
  //   用户依然会收到一句"已写入"——这就是"假成功"。
  //
  //   本节点的职责：拿 HTTP 写的真实状态码，决定最终对用户说什么。
  //   只有 200 / 201 才允许把 success 文案放出去，其余一律如实报失败。
  // ============================================================

  const gate = String(params.gate || '').trim();
  const baseMsg = String(params.base_msg || '');
  const viewUrl = String(params.view_url || '');
  const rawStatus = params.write_status;
  const status = String(rawStatus == null ? '' : rawStatus).trim();
  const rawBody = String(params.write_body || '');
  const body = rawBody.replace(/\s+/g, ' ').trim().slice(0, 180);

  const out = (ok, msg) => ({ ok: ok, msg: msg, view_url: viewUrl });

  // ---- 1. 闸门没过：写入节点压根没执行，透传节点三的说明 ----
  // 这里包含「未写入：xxx」和「vX 已经写过了」两种情况，都是真实的，
  // 因为它们来自代码节点的判定，不依赖 HTTP 请求。
  if (gate !== 'pass') {
    return out(false, baseMsg || '未写入：闸门未通过，请重新预览再确认。');
  }

  // ---- 2. 闸门过了：唯一算成功的证据是 HTTP 返回 2xx ----
  if (status === '200' || status === '201') {
    return out(true, baseMsg);
  }

  // ---- 3. 没拿到状态码：说明写入节点没执行 / 输出没接上 ----
  if (!status) {
    return out(false, '⚠️ 写入没有确认成功（没拿到写入节点的状态码）。\n'
      + '两种可能：\n'
      + '  · 本节点的「写入状态码」没有接上 HTTP 写节点的 status_code；\n'
      + '  · 或者 HTTP 写节点的「异常忽略」开着，失败被吞掉了。\n'
      + '请去 Coze 调试台看这次运行：找 HTTP 写节点，看它的状态码和响应体。');
  }

  // ---- 4. 有状态码但不是 2xx：真失败，把原因说清楚 ----
  let hint = '';
  if (status === '401') {
    hint = 'token 无效或已过期。去 GitHub 重新生成一个，注意鉴权头里不要带尖括号。';
  } else if (status === '403') {
    hint = 'token 没有写权限。把这个 token 的 Contents 权限改成 Read and write（改完不用重新生成）。';
  } else if (status === '404') {
    hint = 'URL 写错了，或 token 的 Resource owner 选错了。path 区分大小写，owner 要填组织名。';
  } else if (status === '409') {
    hint = 'sha 过期了：在你确认之前，这个文件被别人（或你自己）改过。重新预览再确认一次。';
  } else if (status === '422' || status === '400') {
    hint = '请求体不是合法 JSON。最常见是 put_body 被包了一层双引号。';
  } else if (status === '5' || /^5\d\d$/.test(status)) {
    hint = 'GitHub 服务端临时故障。等一会儿重新确认一次即可。';
  } else {
    hint = '按 06 章报错对照表排查。';
  }

  return out(false, '⚠️ 写入失败：HTTP ' + status + '。\n' + hint
    + (body ? '\n（GitHub 返回："' + body + '"）' : ''));
}