(function (global) {
  const BASE_URL = "https://api.getsilkread.com";

  const ERROR_MESSAGES = {
    INVALID_JSON: "The request could not be processed. Please try again.",
    INVALID_EMAIL: "Enter a valid email address.",
    INVALID_PASSWORD: "Enter a valid password.",
    PASSWORD_TOO_SHORT: "Password must be at least 6 characters.",
    INVALID_CODE: "Enter the 4-digit verification code.",
    INVALID_VERIFICATION_CODE: "The verification code is incorrect.",
    VERIFICATION_CODE_INVALID: "The verification code is incorrect.",
    CODE_INCORRECT: "The verification code is incorrect.",
    CODE_EXPIRED: "This verification code has expired. Request a new one.",
    VERIFICATION_CODE_EXPIRED: "This verification code has expired. Request a new one.",
    EMAIL_EXISTS: "This email is already registered. Sign in instead.",
    EMAIL_ALREADY_REGISTERED: "This email is already registered. Sign in instead.",
    ALREADY_REGISTERED: "This email is already registered. Sign in instead.",
    USER_NOT_FOUND: "This email is not registered. Create an account first.",
    EMAIL_NOT_REGISTERED: "This email is not registered. Create an account first.",
    INVALID_CREDENTIALS: "Incorrect email or password.",
    WRONG_PASSWORD: "Incorrect email or password.",
    ACCOUNT_LOCKED: "Too many failed sign-in attempts. Please try again later.",
    LOGIN_LOCKED: "Too many failed sign-in attempts. Please try again later.",
    TOO_MANY_ATTEMPTS: "Too many attempts. Please try again later.",
    RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
    TOO_MANY_REQUESTS: "Too many requests. Please wait a moment and try again.",
    TURNSTILE_REQUIRED: "Complete the security check and try again.",
    TURNSTILE_INVALID: "Security verification failed. Please retry.",
    TURNSTILE_FAILED: "Security verification failed. Please retry.",
    CAPTCHA_REQUIRED: "Complete the security check and try again.",
    CAPTCHA_INVALID: "Security verification failed. Please retry.",
    UNAUTHORIZED: "Your session has expired. Please sign in again.",
    MAIL_SERVICE_UNAVAILABLE: "Email service is temporarily unavailable. Please try again later.",
    EMAIL_SEND_FAILED: "The verification email could not be sent. Please try again later.",
    SERVICE_UNAVAILABLE: "The service is temporarily unavailable. Please try again later.",
    INTERNAL_ERROR: "The server could not complete the request. Please try again later.",
  };

  function url(path) {
    return BASE_URL + (path.startsWith("/") ? path : "/" + path);
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (_) {
      return {};
    }
  }

  function errorMessage(response, data, fallback, options) {
    if (response.status === 429) {
      return "Too many requests. Please wait a moment and try again.";
    }
    if (response.status === 503) {
      return options?.emailService
        ? "Email service is temporarily unavailable. Please try again later."
        : "The service is temporarily unavailable. Please try again later.";
    }

    const code = String(data?.error || "").trim().toUpperCase();
    if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];

    const message = String(data?.message || "").trim();
    if (message && /^[\x20-\x7E]+$/.test(message)) return message;
    return fallback;
  }

  function authHeaders(authToken, includeJson) {
    const headers = {
      Accept: "application/json",
      Authorization: "Bearer " + authToken,
    };
    if (includeJson) headers["Content-Type"] = "application/json";
    return headers;
  }

  function saveSession(authToken, email) {
    localStorage.setItem("authToken", authToken);
    if (email) localStorage.setItem("authEmail", email);
    localStorage.removeItem("token");
    localStorage.removeItem("api_token");
    localStorage.removeItem("user");
  }

  function clearSession() {
    localStorage.removeItem("authToken");
    localStorage.removeItem("authEmail");
    localStorage.removeItem("token");
    localStorage.removeItem("api_token");
    localStorage.removeItem("user");
  }

  function getTurnstileSiteKey() {
    const key = String(global.SILKREAD_TURNSTILE_SITE_KEY || '').trim();
    return key || null;
  }

  global.SilkReadAccountApi = Object.freeze({
    BASE_URL,
    url,
    readJson,
    errorMessage,
    authHeaders,
    saveSession,
    clearSession,
    getTurnstileSiteKey,
  });
})(window);
