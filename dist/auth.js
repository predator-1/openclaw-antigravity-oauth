import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { DEFAULT_ENDPOINTS, DEFAULT_PROJECT_ID, OAUTH_SCOPES, PROVIDER_ID, buildAntigravityHeaders } from "./constants.js";
export function parseFormattedApiKey(raw) {
    if (typeof raw !== "string") {
        return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed);
            const token = (parsed.token ?? parsed.access ?? "").trim();
            if (!token) {
                return null;
            }
            const rawExpires = parsed.expires ?? parsed.expiresAt;
            const expires = typeof rawExpires === "number" && Number.isFinite(rawExpires) && rawExpires > 0
                ? rawExpires
                : undefined;
            return {
                token,
                projectId: typeof parsed.projectId === "string" && parsed.projectId.trim().length > 0
                    ? parsed.projectId.trim()
                    : DEFAULT_PROJECT_ID,
                ...(typeof parsed.accountId === "string" && parsed.accountId.length > 0
                    ? { accountId: parsed.accountId }
                    : {}),
                ...(expires !== undefined ? { expires } : {})
            };
        }
        catch {
            return { token: trimmed, projectId: DEFAULT_PROJECT_ID };
        }
    }
    return { token: trimmed, projectId: DEFAULT_PROJECT_ID };
}
export class InMemoryAuthProfileStore {
    secrets = new Map();
    hasSecret(provider) {
        return this.secrets.has(provider);
    }
    async getSecret(provider) {
        const found = this.secrets.get(provider);
        return found ? { ...found } : null;
    }
    async setSecret(provider, credentials) {
        if (provider !== PROVIDER_ID) {
            throw new Error(`Unsupported provider id: ${provider}`);
        }
        this.secrets.set(provider, { ...credentials });
        return {
            profileId: `${PROVIDER_ID}:${credentials.email ?? credentials.accountId ?? "oauth"}`,
            provider: PROVIDER_ID,
            method: "oauth"
        };
    }
    async deleteSecret(provider) {
        this.secrets.delete(provider);
    }
}
export function isAntigravityConfigured(ctx, authStore, modelAuth) {
    if (authStore?.hasSecret?.(PROVIDER_ID)) {
        return true;
    }
    if (modelAuth) {
        try {
            if (typeof modelAuth.ensureAuthProfileStore === "function" &&
                typeof modelAuth.listProfilesForProvider === "function") {
                const store = modelAuth.ensureAuthProfileStore(ctx?.agentDir, {
                    readOnly: true,
                    allowKeychainPrompt: false
                });
                const profiles = modelAuth.listProfilesForProvider(store, PROVIDER_ID);
                if (Array.isArray(profiles) && profiles.length > 0) {
                    return true;
                }
            }
            if (typeof modelAuth.isProviderApiKeyConfigured === "function") {
                const isKeyConfigured = modelAuth.isProviderApiKeyConfigured({
                    provider: PROVIDER_ID,
                    cfg: ctx?.cfg,
                    agentDir: ctx?.agentDir,
                    readOnly: true,
                    allowKeychainPrompt: false
                });
                if (isKeyConfigured) {
                    return true;
                }
            }
        }
        catch {
            // Ignore host auth check errors; proceed to fallback
        }
    }
    return false;
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Login aborted"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Login aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
function generatePkcePair() {
    const verifier = randomBytes(32).toString("hex");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("hex");
    const upper = state.slice(0, 8).toUpperCase();
    const shortCode = `${upper.slice(0, 4)}-${upper.slice(4, 8)}`;
    return { verifier, challenge, state, shortCode };
}
function parseCallbackInput(input, expectedState) {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error("No authorization code provided");
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        const parsedUrl = new URL(trimmed);
        const error = parsedUrl.searchParams.get("error");
        if (error) {
            throw new Error(`Authentication denied: ${error}`);
        }
        const code = parsedUrl.searchParams.get("code")?.trim();
        const state = parsedUrl.searchParams.get("state")?.trim();
        if (!code) {
            throw new Error("Redirect URL is missing the 'code' query parameter");
        }
        if (state && state !== expectedState) {
            throw new Error("OAuth state mismatch");
        }
        return { code, ...(state ? { state } : {}) };
    }
    return { code: trimmed };
}
async function waitForLocalOAuthCallback(params) {
    const url = new URL(params.redirectUri);
    const port = url.port ? Number(url.port) : 51121;
    const callbackPath = url.pathname || "/oauth-callback";
    return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err, result) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            params.signal?.removeEventListener("abort", onAbort);
            try {
                server.close();
            }
            catch {
                // Ignore close errors
            }
            if (err) {
                reject(err);
            }
            else if (result) {
                resolve(result);
            }
        };
        const onAbort = () => {
            finish(new Error("Login aborted"));
        };
        const timer = setTimeout(() => {
            finish(new Error("OAuth callback timed out"));
        }, params.timeoutMs);
        params.signal?.addEventListener("abort", onAbort, { once: true });
        const server = createServer((req, res) => {
            try {
                const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
                if (reqUrl.pathname !== callbackPath) {
                    res.statusCode = 404;
                    res.end("Not found");
                    return;
                }
                const error = reqUrl.searchParams.get("error");
                if (error) {
                    res.statusCode = 400;
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.end("<html><body><h2>Antigravity sign-in failed.</h2><p>You may close this tab.</p></body></html>");
                    finish(new Error(`Authentication denied: ${error}`));
                    return;
                }
                const code = reqUrl.searchParams.get("code")?.trim();
                const state = reqUrl.searchParams.get("state")?.trim();
                if (!code) {
                    res.statusCode = 400;
                    res.end("Missing code");
                    return;
                }
                if (state && state !== params.expectedState) {
                    res.statusCode = 400;
                    res.end("Invalid state");
                    finish(new Error("OAuth state mismatch"));
                    return;
                }
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end("<html><body><h2>Antigravity subscription connected to OpenClaw.</h2><p>You can close this window and return to your terminal.</p></body></html>");
                finish(undefined, { code });
            }
            catch (err) {
                finish(err instanceof Error ? err : new Error(String(err)));
            }
        });
        server.once("error", (err) => {
            finish(err instanceof Error ? err : new Error(String(err)));
        });
        server.listen(port, "127.0.0.1");
    });
}
export function extractProjectId(raw) {
    if (typeof raw === "string" && raw.trim().length > 0) {
        return raw.trim();
    }
    if (raw && typeof raw === "object") {
        if (typeof raw.id === "string" && raw.id.trim().length > 0) {
            return raw.id.trim();
        }
        if (typeof raw.name === "string" && raw.name.trim().length > 0) {
            return raw.name.trim();
        }
        if (typeof raw.project === "string" && raw.project.trim().length > 0) {
            return raw.project.trim();
        }
    }
    return undefined;
}
async function verifyEligibility(accessToken, endpoints, fetchImpl, signal) {
    const response = await fetchImpl(endpoints.verifySubscriptionUrl, {
        method: "POST",
        headers: {
            ...buildAntigravityHeaders(accessToken),
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: JSON.stringify({
            metadata: {
                ideType: "ANTIGRAVITY"
            }
        }),
        ...(signal ? { signal } : {})
    });
    if (response.status === 401 || response.status === 403) {
        return { eligible: false };
    }
    if (!response.ok) {
        throw new Error("subscription not eligible");
    }
    const data = (await response.json());
    // Explicit boolean contract (used by unit/acceptance tests and direct verification endpoints)
    if (data.eligible === false) {
        return { eligible: false };
    }
    const rawProjectId = extractProjectId(data.cloudaicompanionProject);
    const tierId = data.currentTier?.id?.trim();
    const hasAllowedTier = Array.isArray(data.allowedTiers) && data.allowedTiers.length > 0;
    if (data.eligible !== true && !rawProjectId && !tierId && !hasAllowedTier) {
        return { eligible: false };
    }
    const projectId = rawProjectId ?? (data.eligible !== true ? DEFAULT_PROJECT_ID : undefined);
    let email;
    if (endpoints.userInfoUrl && data.eligible !== true) {
        try {
            const userRes = await fetchImpl(endpoints.userInfoUrl, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/json"
                },
                ...(signal ? { signal } : {})
            });
            if (userRes.ok) {
                const userInfo = (await userRes.json());
                if (typeof userInfo.email === "string" && userInfo.email.trim().length > 0) {
                    email = userInfo.email.trim();
                }
            }
        }
        catch {
            // Non-fatal if userinfo endpoint is unreachable
        }
    }
    const resolvedAccountId = typeof data.accountId === "string" && data.accountId.trim().length > 0
        ? data.accountId.trim()
        : email ?? projectId ?? tierId;
    return {
        eligible: true,
        ...(resolvedAccountId !== undefined ? { accountId: resolvedAccountId } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(email !== undefined ? { email } : {})
    };
}
async function exchangeAuthCodeForTokens(params) {
    const bodyParams = new URLSearchParams({
        client_id: params.endpoints.clientId,
        code: params.code,
        redirect_uri: params.redirectUri,
        grant_type: "authorization_code"
    });
    if (params.endpoints.clientSecret) {
        bodyParams.set("client_secret", params.endpoints.clientSecret);
    }
    if (params.codeVerifier) {
        bodyParams.set("code_verifier", params.codeVerifier);
    }
    const tokenRes = await params.fetchImpl(params.endpoints.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: bodyParams.toString(),
        ...(params.signal ? { signal: params.signal } : {})
    });
    if (!tokenRes.ok) {
        throw new Error(`Authentication failed during authorization code exchange (${tokenRes.status})`);
    }
    const tokenBody = (await tokenRes.json());
    if (!tokenBody.access_token || !tokenBody.refresh_token) {
        throw new Error("Authentication failed: incomplete token response");
    }
    return {
        accessToken: tokenBody.access_token,
        refreshToken: tokenBody.refresh_token,
        expiresInSec: typeof tokenBody.expires_in === "number" ? tokenBody.expires_in : 3600
    };
}
export async function loginWithOAuth(ctx, endpoints = DEFAULT_ENDPOINTS, fetchImpl = fetch, pollIntervalOverrideMs) {
    // Contract §2: "An API key is not this product. Do not add --method api-key."
    if (ctx.method !== "oauth") {
        throw new Error(`Unsupported auth method "${ctx.method}". Only "--method oauth" is supported.`);
    }
    let accessToken = "";
    let refreshToken = "";
    let expiresInSec = 3600;
    if (ctx.localLoopback === true && ctx.loopbackCode && ctx.loopbackRedirectUri) {
        const exchanged = await exchangeAuthCodeForTokens({
            code: ctx.loopbackCode,
            redirectUri: ctx.loopbackRedirectUri,
            ...(ctx.loopbackCodeVerifier ? { codeVerifier: ctx.loopbackCodeVerifier } : {}),
            endpoints,
            fetchImpl,
            ...(ctx.signal ? { signal: ctx.signal } : {})
        });
        accessToken = exchanged.accessToken;
        refreshToken = exchanged.refreshToken;
        expiresInSec = exchanged.expiresInSec;
    }
    else {
        // 1. Try RFC 8628 Device-Code flow first (Contract §2 default)
        const deviceRes = await fetchImpl(endpoints.deviceCodeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams({
                client_id: endpoints.clientId,
                scope: OAUTH_SCOPES
            }).toString(),
            ...(ctx.signal ? { signal: ctx.signal } : {})
        });
        if (deviceRes.ok) {
            const deviceData = (await deviceRes.json());
            const verificationUrl = deviceData.verification_url ?? deviceData.verification_uri;
            const userCode = deviceData.user_code;
            const deviceCode = deviceData.device_code;
            if (!verificationUrl || !userCode || !deviceCode) {
                throw new Error("Invalid device-code response from authorization server");
            }
            // Contract §2: Print URL and short code; never print tokens or headers.
            ctx.print(`To sign in to your Antigravity subscription, visit: ${verificationUrl}`);
            ctx.print(`Enter code: ${userCode}`);
            const expiresInMs = (deviceData.expires_in ?? 900) * 1000;
            const pollIntervalMs = pollIntervalOverrideMs ?? (deviceData.interval ?? 5) * 1000;
            const deadline = Date.now() + expiresInMs;
            while (Date.now() < deadline) {
                await sleep(pollIntervalMs, ctx.signal);
                const pollParams = new URLSearchParams({
                    client_id: endpoints.clientId,
                    device_code: deviceCode,
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code"
                });
                if (endpoints.clientSecret) {
                    pollParams.set("client_secret", endpoints.clientSecret);
                }
                const pollRes = await fetchImpl(endpoints.tokenUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
                    body: pollParams.toString(),
                    ...(ctx.signal ? { signal: ctx.signal } : {})
                });
                const pollData = (await pollRes.json());
                if (pollRes.ok && pollData.access_token && pollData.refresh_token) {
                    accessToken = pollData.access_token;
                    refreshToken = pollData.refresh_token;
                    if (typeof pollData.expires_in === "number") {
                        expiresInSec = pollData.expires_in;
                    }
                    break;
                }
                if (pollData.error === "authorization_pending" || pollData.error === "slow_down") {
                    continue;
                }
                if (pollData.error === "access_denied") {
                    throw new Error("Authentication denied by user");
                }
                if (pollData.error === "expired_token") {
                    throw new Error("Device code expired before sign-in completed");
                }
                throw new Error(`Authentication failed: ${pollData.error ?? pollRes.statusText}`);
            }
            if (!accessToken || !refreshToken) {
                throw new Error("Device-code login timed out");
            }
        }
        else if ((deviceRes.status === 400 || deviceRes.status === 401) &&
            endpoints.authUrl &&
            (ctx.localLoopback === true || !ctx.isRemote || ctx.promptText !== undefined)) {
            // Fallback for Google's Installed/Desktop Antigravity OAuth client ID (which uses PKCE):
            // Prints the URL and short verification code, and uses either local loopback (when local)
            // or manual redirect URL/code entry (when remote/SSH).
            const redirectUri = ctx.loopbackRedirectUri ??
                endpoints.loopbackRedirectUri ??
                "http://localhost:51121/oauth-callback";
            const pkce = generatePkcePair();
            const authParams = new URLSearchParams({
                client_id: endpoints.clientId,
                response_type: "code",
                redirect_uri: redirectUri,
                scope: OAUTH_SCOPES,
                code_challenge: pkce.challenge,
                code_challenge_method: "S256",
                state: pkce.state,
                access_type: "offline",
                prompt: "consent"
            });
            const authorizeUrl = `${endpoints.authUrl}?${authParams.toString()}`;
            ctx.print(`To sign in to your Antigravity subscription, visit: ${authorizeUrl}`);
            ctx.print(`Verification code: ${pkce.shortCode}`);
            let authCode = "";
            if (!ctx.isRemote) {
                const callbackPromise = waitForLocalOAuthCallback({
                    redirectUri,
                    expectedState: pkce.state,
                    timeoutMs: 300_000,
                    ...(ctx.signal ? { signal: ctx.signal } : {})
                });
                if (ctx.openUrl) {
                    await ctx.openUrl(authorizeUrl).catch(() => { });
                }
                try {
                    const cb = await callbackPromise;
                    authCode = cb.code;
                }
                catch (err) {
                    if (ctx.promptText) {
                        const rawInput = await ctx.promptText("Paste the redirect URL (or authorization code) from your browser:");
                        authCode = parseCallbackInput(rawInput, pkce.state).code;
                    }
                    else {
                        throw err;
                    }
                }
            }
            else if (ctx.promptText) {
                const rawInput = await ctx.promptText("After signing in, paste the full redirect URL (or authorization code) here:");
                authCode = parseCallbackInput(rawInput, pkce.state).code;
            }
            else {
                throw new Error(`Failed to initiate device-code login (${deviceRes.status})`);
            }
            const exchanged = await exchangeAuthCodeForTokens({
                code: authCode,
                redirectUri,
                codeVerifier: pkce.verifier,
                endpoints,
                fetchImpl,
                ...(ctx.signal ? { signal: ctx.signal } : {})
            });
            accessToken = exchanged.accessToken;
            refreshToken = exchanged.refreshToken;
            expiresInSec = exchanged.expiresInSec;
        }
        else {
            throw new Error(`Failed to initiate device-code login (${deviceRes.status})`);
        }
    }
    // Contract §2: "If the account is not eligible, login exits non-zero with error text
    // `subscription not eligible`. Do not create a half-saved profile."
    const eligibility = await verifyEligibility(accessToken, endpoints, fetchImpl, ctx.signal);
    if (!eligibility.eligible) {
        await ctx.authStore.deleteSecret(PROVIDER_ID);
        throw new Error("subscription not eligible");
    }
    const credentials = {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + expiresInSec * 1000,
        ...(eligibility.accountId !== undefined ? { accountId: eligibility.accountId } : {}),
        ...(eligibility.email !== undefined ? { email: eligibility.email } : {}),
        ...(eligibility.projectId !== undefined ? { projectId: eligibility.projectId } : {})
    };
    const profile = await ctx.authStore.setSecret(PROVIDER_ID, credentials);
    return {
        profile,
        ...(eligibility.accountId !== undefined ? { accountId: eligibility.accountId } : {}),
        ...(eligibility.email !== undefined ? { email: eligibility.email } : {}),
        ...(eligibility.projectId !== undefined ? { projectId: eligibility.projectId } : {})
    };
}
function getProfileHint(profileId) {
    if (!profileId)
        return "";
    const hash = createHash("sha256").update(profileId).digest("hex").slice(0, 8);
    return ` [profile: ${hash}]`;
}
export async function refreshOAuthCredential(credential, endpoints = DEFAULT_ENDPOINTS, fetchImpl = fetch) {
    if (!credential.refresh || credential.refresh === "managed-by-openclaw") {
        throw new Error("Authentication error: missing refresh token for Antigravity credential");
    }
    const bodyParams = new URLSearchParams({
        client_id: endpoints.clientId,
        refresh_token: credential.refresh,
        grant_type: "refresh_token"
    });
    if (endpoints.clientSecret) {
        bodyParams.set("client_secret", endpoints.clientSecret);
    }
    const maxAttempts = 3;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let response;
        try {
            response = await fetchImpl(endpoints.tokenUrl, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
                body: bodyParams.toString()
            });
        }
        catch (networkErr) {
            lastError = networkErr;
            if (attempt < maxAttempts) {
                const backoffMs = Math.round(200 * Math.pow(2, attempt - 1) + Math.random() * 100);
                await sleep(backoffMs);
                continue;
            }
            throw new Error(`Authentication error: network failure during token refresh (${networkErr instanceof Error ? networkErr.message : String(networkErr)})`);
        }
        if (!response.ok) {
            let errCode = "";
            let errDescription = "";
            try {
                const errJson = (await response.json());
                if (errJson) {
                    if (typeof errJson.error === "string")
                        errCode = errJson.error;
                    if (typeof errJson.error_description === "string")
                        errDescription = errJson.error_description;
                }
            }
            catch {
                // Body not JSON
            }
            const detailParts = [];
            if (errCode)
                detailParts.push(`error: ${errCode}`);
            if (errDescription)
                detailParts.push(`description: ${errDescription}`);
            const details = detailParts.length > 0 ? ` [${detailParts.join(", ")}]` : "";
            const profileHint = getProfileHint(credential.profileId);
            console.warn(`[antigravity] OAuth token refresh failed for provider "antigravity"${profileHint}: HTTP ${response.status}${details} (attempt ${attempt}/${maxAttempts})`);
            // Never retry invalid_grant
            if (errCode === "invalid_grant" || /invalid_grant/i.test(errDescription)) {
                throw new Error(`Authentication error: OAuth refresh token is invalid or revoked (${response.status})${details}. Re-login required: openclaw models auth login --provider antigravity`);
            }
            // Retry 5xx errors with exponential backoff + jitter
            if (response.status >= 500 && attempt < maxAttempts) {
                const backoffMs = Math.round(200 * Math.pow(2, attempt - 1) + Math.random() * 100);
                await sleep(backoffMs);
                continue;
            }
            if (response.status >= 500) {
                const transientErr = new Error(`Authentication error: transient upstream token refresh failure (${response.status})${details}. Please retry.`);
                transientErr.transient = true;
                transientErr.retryable = true;
                throw transientErr;
            }
            throw new Error(`Authentication error: token refresh failed (${response.status})${details}`);
        }
        const data = (await response.json());
        if (!data.access_token) {
            throw new Error("Authentication error: token refresh did not return an access token");
        }
        const expiresInSeconds = typeof data.expires_in === "number" && !Number.isNaN(data.expires_in)
            ? data.expires_in
            : Number(data.expires_in) || 3600;
        const newExpires = Date.now() + expiresInSeconds * 1000;
        const oldExpiresIso = typeof credential.expires === "number" && credential.expires > 0
            ? new Date(credential.expires).toISOString()
            : "unknown";
        const newExpiresIso = new Date(newExpires).toISOString();
        const profileHint = getProfileHint(credential.profileId);
        console.info(`[antigravity] OAuth token refresh succeeded for provider "antigravity"${profileHint} (old expiry: ${oldExpiresIso}, new expiry: ${newExpiresIso})`);
        return {
            ...credential,
            type: "oauth",
            provider: PROVIDER_ID,
            access: data.access_token,
            refresh: data.refresh_token ?? credential.refresh,
            expires: newExpires
        };
    }
    throw lastError instanceof Error
        ? lastError
        : new Error("Authentication error: token refresh attempts exhausted");
}
export async function refreshAccessToken(authStore, endpoints = DEFAULT_ENDPOINTS, fetchImpl = fetch) {
    const existing = await authStore.getSecret(PROVIDER_ID);
    if (!existing || !existing.refreshToken || existing.refreshToken === "managed-by-openclaw") {
        throw new Error("Authentication error: no stored Antigravity subscription credential");
    }
    const refreshed = await refreshOAuthCredential({
        type: "oauth",
        provider: PROVIDER_ID,
        access: existing.accessToken,
        refresh: existing.refreshToken,
        expires: existing.expiresAt,
        ...(existing.email !== undefined ? { email: existing.email } : {}),
        ...(existing.projectId !== undefined ? { projectId: existing.projectId } : {}),
        ...(existing.accountId !== undefined ? { accountId: existing.accountId } : {})
    }, endpoints, fetchImpl);
    const updated = {
        accessToken: refreshed.access,
        refreshToken: refreshed.refresh,
        expiresAt: refreshed.expires,
        ...(existing.accountId !== undefined ? { accountId: existing.accountId } : {}),
        ...(existing.email !== undefined ? { email: existing.email } : {}),
        ...(existing.projectId !== undefined ? { projectId: existing.projectId } : {})
    };
    await authStore.setSecret(PROVIDER_ID, updated);
    return updated;
}
export async function getValidAccessToken(authStore, endpoints = DEFAULT_ENDPOINTS, fetchImpl = fetch) {
    const existing = await authStore.getSecret(PROVIDER_ID);
    if (!existing || !existing.accessToken) {
        throw new Error("Authentication error: not signed in to Antigravity subscription");
    }
    // Refresh if expired or within 60 seconds of expiry
    if (Date.now() >= existing.expiresAt - 60_000) {
        if (!existing.refreshToken || existing.refreshToken === "managed-by-openclaw") {
            // Managed by host or static token without real refresh token; return as-is
            return existing.accessToken;
        }
        const refreshed = await refreshAccessToken(authStore, endpoints, fetchImpl);
        return refreshed.accessToken;
    }
    return existing.accessToken;
}
//# sourceMappingURL=auth.js.map