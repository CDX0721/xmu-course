#!/usr/bin/env bash
# xmu-curl-login.sh —— 只用 curl + openssl 完成 lnt.xmu.edu.cn 登录，产出 Netscape cookie jar
# 用法: XMU_USER=学号 XMU_PASS=密码 ./xmu-curl-login.sh [输出jar路径]
# 之后: curl -s -b jar.txt https://lnt.xmu.edu.cn/api/profile
set -euo pipefail

LNT="https://lnt.xmu.edu.cn"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
JAR="${1:-jar.txt}"
: "${XMU_USER:?需要环境变量 XMU_USER}"
: "${XMU_PASS:?需要环境变量 XMU_PASS}"

# 1) 未登录访问 API，让 curl 自己跟完 LNT -> Keycloak -> CAS 的整条重定向链
#    %{url_effective} 给出最终落点（CAS 登录页，URL 上带 service=），省掉手工拼跳
FINAL=$(curl -sSL -A "$UA" -c "$JAR" -b "$JAR" -o login_page.html -w '%{url_effective}' "$LNT/api/profile")
case "$FINAL" in
  *ids.xmu.edu.cn*) : ;;
  *) echo "没落到 CAS 登录页，可能已有有效会话：$FINAL" >&2; exit 1 ;;
esac

# 2) 从登录页取加密盐与流程令牌
SALT=$(grep -oE 'id="pwdEncryptSalt"[^>]*value="[^"]+"' login_page.html | head -1 | sed -E 's/.*value="([^"]+)".*/\1/')
EXEC=$(grep -oE 'name="execution"[^>]*value="[^"]*"' login_page.html | head -1 | sed -E 's/.*value="([^"]*)".*/\1/')
LT=$(grep -oE 'name="lt"[^>]*value="[^"]*"' login_page.html | head -1 | sed -E 's/.*value="([^"]*)".*/\1/')
[ -n "$SALT" ] || { echo "没解析到 pwdEncryptSalt，登录页结构可能变了" >&2; exit 1; }

# 3) 密码加密：AES-128-CBC/Pkcs7，key=pwdEncryptSalt 的 UTF-8 十六进制，iv=随机16个ASCII字符
#    明文 = 64个随机ASCII字符 + 明文密码；输出标准 base64。IV 无需上传（只影响第一个分组，而前64字节服务端会丢掉）
KEYHEX=$(printf '%s' "$SALT" | od -An -v -tx1 | tr -d ' \n')
IVSTR=$(openssl rand -hex 8)
IVHEX=$(printf '%s' "$IVSTR" | od -An -v -tx1 | tr -d ' \n')
PREFIX=$(openssl rand -hex 32)   # 64 个字符
ENC=$(printf '%s%s' "$PREFIX" "$XMU_PASS" | openssl enc -aes-128-cbc -K "$KEYHEX" -iv "$IVHEX" -nosalt | openssl base64 -A)

# 4) POST 回同一个 URL（service 参数就在上面），curl 自动跟完 ticket 回跳链，LNT 会话 cookie 落进 jar
curl -sSL -A "$UA" -c "$JAR" -b "$JAR" -o after.html -e "$FINAL" \
  --data-urlencode "username=$XMU_USER" \
  --data-urlencode "password=$ENC" \
  --data-urlencode "lt=$LT" \
  --data-urlencode "execution=$EXEC" \
  --data-urlencode "_eventId=submit" \
  --data-urlencode "dllt=generalLogin" \
  --data-urlencode "cllt=userNameLogin" \
  --data-urlencode "rmShown=1" \
  "$FINAL" >/dev/null

# 5) 验证
CODE=$(curl -s -o me.json -w '%{http_code}' -A "$UA" -b "$JAR" -c "$JAR" "$LNT/api/profile")
if [ "$CODE" = 200 ] && head -c1 me.json | grep -q '{'; then
  echo "LOGIN OK -> $JAR"
  grep -oE '"name":"[^"]*"|"user_no":"[^"]*"' me.json | head -2
else
  echo "登录失败 HTTP $CODE；CAS 返回片段：" >&2
  grep -oE 'id="msg"[^>]*>[^<]+|class="tips"[^>]*>[^<]+' after.html | head -2 >&2
  exit 1
fi
