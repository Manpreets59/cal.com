import { ExchangeAuthentication, ExchangeVersion } from "../enums";

export interface ExchangeConfig {
  url: string;
  username: string;
  password: string;
  authenticationMethod: ExchangeAuthentication;
  exchangeVersion: ExchangeVersion;
  useCompression?: boolean;
}

export class ExchangeConfigValidator {
  /**
   * Validates Exchange configuration and provides specific error messages
   */
  static validate(config: Partial<ExchangeConfig>): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // URL validation
    if (!config.url) {
      errors.push("Exchange URL is required");
    } else if (!this.isValidEwsUrl(config.url)) {
      errors.push(
        "URL must be a valid Exchange Web Services (EWS) endpoint (e.g., https://mail.company.com/ews/Exchange.asmx)"
      );
    }

    // Username validation
    if (!config.username) {
      errors.push("Username is required");
    } else if (!this.isValidEmail(config.username)) {
      errors.push("Username must be a valid email address");
    }

    // Password validation
    if (!config.password) {
      errors.push("Password is required");
    } else if (config.password.length < 1) {
      errors.push("Password cannot be empty");
    }

    // Authentication method validation
    if (
      config.authenticationMethod !== undefined &&
      !Object.values(ExchangeAuthentication).includes(config.authenticationMethod)
    ) {
      errors.push("Invalid authentication method");
    }

    // Exchange version validation
    if (
      config.exchangeVersion !== undefined &&
      !Object.values(ExchangeVersion).includes(config.exchangeVersion)
    ) {
      errors.push("Invalid Exchange version");
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Checks if URL is a valid EWS endpoint
   */
  private static isValidEwsUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);

      // Must be HTTPS for security
      if (urlObj.protocol !== "https:") {
        return false;
      }

      // Must contain EWS-specific path patterns
      const path = urlObj.pathname.toLowerCase();
      return (
        path.includes("/ews/") ||
        path.includes("/exchange.asmx") ||
        path.includes("/microsoft-server-activesync")
      );
    } catch {
      return false;
    }
  }

  /**
   * Basic email validation
   */
  private static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Suggests fixes for common configuration issues
   */
  static getSuggestions(config: Partial<ExchangeConfig>): string[] {
    const suggestions: string[] = [];

    if (config.url) {
      const urlObj = new URL(config.url);

      if (urlObj.protocol === "http:") {
        suggestions.push("Consider using HTTPS instead of HTTP for better security");
      }

      if (!urlObj.pathname.toLowerCase().includes("/ews/")) {
        suggestions.push("EWS URL typically ends with '/ews/Exchange.asmx'");
      }
    }

    if (config.authenticationMethod === ExchangeAuthentication.NTLM) {
      suggestions.push(
        "NTLM authentication may require NODE_OPTIONS='--openssl-legacy-provider' for older Exchange servers"
      );
    }

    if (config.exchangeVersion && config.exchangeVersion < ExchangeVersion.Exchange2013) {
      suggestions.push("Consider upgrading to Exchange 2013 or later for better compatibility");
    }

    return suggestions;
  }
}
