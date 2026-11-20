# 校验一个 Gemini API key 是否有效（不回显、不落盘）
#
# 用法：
#   pwsh -File tools/check-key.ps1
#   （运行后粘贴 key，回车。屏幕不会显示内容。）
#
# 判定标准：
#   * 形状：`AQ.` 开头的 53 字符（新版 AI Studio key）或 `AIza` 开头的 39 字符（旧版）
#   * 实效：直连 generativelanguage.googleapis.com 列模型，200 = 有效
param([string]$Key)

if (-not $Key) {
    $secure = Read-Host -AsSecureString "粘贴 Gemini API key（不回显）"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $Key = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$Key = $Key.Trim()
$len = $Key.Length
$prefix = if ($len -ge 4) { $Key.Substring(0, 4) } else { $Key }
$suffix = if ($len -ge 4) { $Key.Substring($len - 4) } else { $Key }

Write-Host ("形状   : 长度={0} 前缀={1} 后缀={2}" -f $len, $prefix, $suffix)
if ($Key -match '\s') { Write-Host "警告   : 含空白字符，粘贴时可能带入了空格或换行" -ForegroundColor Yellow }

$shape = 'unknown'
if ($Key -match '^AQ\.[A-Za-z0-9_\-]{40,}$') { $shape = 'AQ（新版）' }
elseif ($Key -match '^AIza[0-9A-Za-z_\-]{30,}$') { $shape = 'AIza（旧版）' }
Write-Host ("格式   : {0}" -f $shape)
if ($shape -eq 'unknown') {
    Write-Host "结论   : 这不像 Gemini API key（常见误填：项目 ID、key id、其它厂商的 token）" -ForegroundColor Red
}

try {
    $response = Invoke-WebRequest -Uri 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200' `
        -Headers @{ 'x-goog-api-key' = $Key } -UseBasicParsing -TimeoutSec 25
    $json = $response.Content | ConvertFrom-Json
    $count = ($json.models | Measure-Object).Count
    Write-Host ("结果   : HTTP {0}，可用模型 {1} 个 → key 有效" -f $response.StatusCode, $count) -ForegroundColor Green
} catch {
    $resp = $_.Exception.Response
    if ($resp) {
        $status = [int]$resp.StatusCode
        $reader = New-Object IO.StreamReader($resp.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reason = if ($body -match '"reason"\s*:\s*"([^"]+)"') { $matches[1] } else { '' }
        Write-Host ("结果   : HTTP {0} {1} → key 不可用" -f $status, $reason) -ForegroundColor Red
        if ($reason -eq 'API_KEY_INVALID') { Write-Host "        请到 https://aistudio.google.com/apikey 重新复制那把 key" }
    } else {
        Write-Host ("结果   : 网络错误 {0}（可能是节点未连通）" -f $_.Exception.Message) -ForegroundColor Yellow
    }
}
