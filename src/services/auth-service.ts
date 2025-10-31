import { createOAuthDeviceAuth } from '@octokit/auth-oauth-device';
import fetch from 'node-fetch';
import { config } from '../config/index.js';
import { CopilotToken, VerificationResponse } from '../types/github.js';
import { logger } from '../utils/logger.js';

// In-memory token storage
// Note: In a production environment with multiple instances,
// you might want to use Redis or another shared cache
let githubToken: string | null = null;
let copilotToken: CopilotToken | null = null;

/**
 * Initialize the OAuth device flow for GitHub authentication
 * @returns Promise<VerificationResponse> Device verification info
 */
export async function initiateDeviceFlow(): Promise<VerificationResponse> {
  let settled = false;

  return new Promise<VerificationResponse>((resolve, reject) => {
    const auth = createOAuthDeviceAuth({
      clientType: "oauth-app",
      clientId: config.github.copilot.clientId,
      scopes: ["read:user"],
      onVerification: ({ verification_uri, user_code, expires_in, interval }) => {
        if (settled) {
          return;
        }
        settled = true;
        logger.info('Device verification initiated', { 
          verification_uri,
          user_code 
        });
        resolve({
          verification_uri,
          user_code,
          expires_in,
          interval,
          status: 'pending_verification'
        });
      },
    });

    auth({ type: "oauth" }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes('authorization_pending')) {
        // Expected while waiting for user verification; do not reject.
        return;
      }
      
      logger.error('Failed to initiate device flow:', error);
      if (!settled) {
        settled = true;
        reject(new Error('Failed to initiate GitHub authentication'));
      }
    });
  });
}

/**
 * Check if the user has completed the device flow authorization
 * @returns Promise<boolean> Whether authentication was successful
 */
export async function checkDeviceFlowAuth(): Promise<boolean> {
  // If already authenticated, return true
  if (githubToken && copilotToken) {
    return true;
  }

  const auth = createOAuthDeviceAuth({
    clientType: "oauth-app",
    clientId: config.github.copilot.clientId,
    scopes: ["read:user"],
    onVerification: () => undefined,
  });

  try {
    // This will throw if the user hasn't authorized yet
    const tokenAuth = await auth({ type: "oauth" });
    
    if (tokenAuth.token) {
      // Successfully authenticated
      githubToken = tokenAuth.token;
      
      // Get Copilot token using GitHub token
      await refreshCopilotToken();
      
      return true;
    }
    
    return false;
  } catch (error: unknown) {
    // If it's a pending authorization, that's expected
    if (error instanceof Error && error.message.includes('authorization_pending')) {
      return false;
    }
    
    // Log other errors
    logger.error('Error checking device flow auth:', error);
    throw error;
  }
}

/**
 * Refresh the Copilot token using the GitHub token
 * @returns Promise<CopilotToken> The refreshed Copilot token
 */
export async function refreshCopilotToken(): Promise<CopilotToken> {
  if (!githubToken) {
    throw new Error('GitHub token is required for refresh');
  }

  try {
    const response = await fetch(config.github.copilot.apiEndpoints.GITHUB_COPILOT_TOKEN, {
      method: 'GET',
      headers: {
        'Authorization': `token ${githubToken}`,
        'Editor-Version': 'Cursor-IDE/1.0.0',
        'Editor-Plugin-Version': 'copilot-cursor/1.0.0'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get Copilot token: ${response.status} ${response.statusText}`);
    }

    copilotToken = await response.json() as CopilotToken;
    logger.info('Copilot token refreshed', { 
      expires_at: new Date(copilotToken.expires_at * 1000).toISOString() 
    });
    
    return copilotToken;
  } catch (error) {
    logger.error('Error refreshing Copilot token:', error);
    throw error;
  }
}

/**
 * Get the current Copilot token
 * @returns CopilotToken | null The current token or null if not authenticated
 */
export function getCopilotToken(): CopilotToken | null {
  return copilotToken;
}

/**
 * Check if the current token is valid and not expired
 * @returns boolean Whether the token is valid
 */
export function isTokenValid(): boolean {
  if (!copilotToken || !copilotToken.token) {
    return false;
  }
  
  const now = Math.floor(Date.now() / 1000);
  // Add a small buffer to ensure we don't use tokens that are about to expire
  return now < (copilotToken.expires_at - 60);
}

/**
 * Clear all authentication tokens
 */
export function clearTokens(): void {
  githubToken = null;
  copilotToken = null;
  logger.info('Authentication tokens cleared');
}
