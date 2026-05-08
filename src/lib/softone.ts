import { logger } from './logger';

// ── Types ──────────────────────────────────────────────────────────────────

type SoftOneConfig = {
  endpoint: string;
  apiEndpoint: string;
  username: string;
  password: string;
  appId: string;
};

type SoftOneSession = {
  clientID: string;
  company: string;
  branch: string;
  module: string;
  refid: string;
  createdAt: number;
};

type LoginObjs = {
  COMPANY: string;
  BRANCH: string;
  MODULE: string;
  REFID: string;
};

type LoginResponse = {
  success: boolean;
  clientID?: string;
  objs?: LoginObjs[];
  error?: string;
  errorcode?: number;
};

type AuthenticateResponse = {
  success: boolean;
  clientID?: string;
  error?: string;
  errorcode?: number;
};

export type SetProjectParams = {
  code?: string;
  name: string;
  shortdesc?: string;
  formdesc?: string;
  prjlocation?: string;
  custcode?: string;
  prjparent?: string;
  custbranch?: string;
  eufwc?: string;
  ismaster?: boolean;
  custmanager?: string;
  ordernum?: string;
  relatedprj?: string;
  vatexemption?: string;
  masterparent?: string;
  salesman?: string;
  salesrep?: string;
  designengineer?: string;
  businessunit?: string;
  implementmanager?: string;
  prjitem?: string;
  startnetvalue?: number;
  netordvalue?: number;
  netservicevalue?: number;
  onlyservices?: number;
  nextyearprice?: number;
  costestimate?: number;
  servicecostestimate?: number;
  shipaddress?: string;
  shipdistrict?: string;
  pendingissues?: string;
  prjstatus?: string;
  finantialsituation?: string;
  contract?: number;
  prjtype?: number;
  paymentmeth?: string;
  bscscore?: number;
  city?: string;
  shipzip?: string;
  shipcity?: string;
  priority?: number;
  assigndate?: string;
  agreeddeldate?: string;
  progdispatch?: string;
  servicestart?: string;
  serviceend?: string;
  requestdate?: string;
  offerdate?: string;
  offerdeadline?: string;
  confirmationdate?: string;
  provacceptancedate?: string;
  finalacceptncedate?: string;
};

export type SetProjectResult = {
  success: boolean;
  id: number;
  code: string;
  message?: string;
};

// ── setItem Types ─────────────────────────────────────────────────────────

export type SetItemEntry = {
  code: string;
  code1?: string;
  code2?: string;
  name: string;
  name1?: string;
  mtrunit: number;
  vat: number;
  mtracn: number;
  mtrcategory: number;
  mtrmanfctr?: string;
  busunits?: string;
  category?: string;
  subcateg?: string;
  type?: string;
};

export type SetItemParams = {
  items: SetItemEntry[];
};

export type SetItemResultEntry = {
  Item_id: number;
  Item_code: string;
  Item_name: string;
};

export type SetItemResult = {
  success: boolean;
  id: number;
  Items: SetItemResultEntry[];
};

// ── updatePrjStatus Types ─────────────────────────────────────────────────

export type UpdatePrjStatusParams = {
  key: number;    // Project ID in ERP
  status: number; // Status code (e.g. 7 = Προ Αίτημα Προσφοράς, 90 = Δεν έχουν ολοκληρωθεί οι λίστες)
};

export type UpdatePrjStatusResult = {
  success: boolean;
  id: number;
  message?: string;
};

// ── setDocs Types ─────────────────────────────────────────────────────────

export type SetDocsLineItem = {
  productcode: string;
  qty1: string;
  price: string;
  discount?: string;
  lineval?: string;
  cost?: string;
  warranty?: string; // warranty in months
  position?: string; // Position No. (our line itemno / TreeOrdering)
  comments?: string; // line comments (OfferDetails.Comment)
};

export type SetDocsParams = {
  custcode: string;
  projectcode?: string;
  date?: string;
  status?: string;
  comments?: string;
  comments1?: string;
  shpaddr?: string;
  shpzip?: string;
  shpdistrict?: string;
  shpcity?: string;
  sumamnt?: number;
  items: SetDocsLineItem[];
};

export type SetDocsResult = {
  success: boolean;
  id: number;
  code: string;
  message?: string;
};

type ServiceErrorResponse = {
  success: false;
  error: string;
  errorcode?: number;
};

// ── Constants ──────────────────────────────────────────────────────────────

/** Session TTL in milliseconds (20 minutes — SoftOne sessions typically expire at 30 min) */
const SESSION_TTL_MS = 20 * 60 * 1000;

// ── Client ─────────────────────────────────────────────────────────────────

class SoftOneClient {
  private config: SoftOneConfig;
  private session: SoftOneSession | null = null;
  private sessionPromise: Promise<SoftOneSession> | null = null;

  constructor(config: SoftOneConfig) {
    this.config = config;
  }

  // SoftOne (on-premise/oncloud.gr) returns JSON bodies encoded in Windows-1253
  // regardless of Content-Type, so response.json() produces U+FFFD for Greek chars.
  // Decode bytes as Windows-1253 before parsing to preserve Greek text.
  private async readJson<T>(response: Response): Promise<T> {
    const buffer = await response.arrayBuffer();
    const text = new TextDecoder('windows-1253').decode(buffer);
    return JSON.parse(text) as T;
  }

  // ── Authentication ─────────────────────────────────────────────────────

  /**
   * Step 1: Login to SoftOne WS. Returns clientID + objs for authenticate.
   */
  private async login(): Promise<{ clientID: string; objs: LoginObjs }> {
    const body = {
      service: 'login',
      username: this.config.username,
      password: this.config.password,
      appId: this.config.appId,
    };

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`SoftOne login HTTP error: ${response.status} ${response.statusText}`);
    }

    const data = await this.readJson<LoginResponse>(response);

    if (!data.success || !data.clientID || !data.objs || data.objs.length === 0) {
      throw new Error(`SoftOne login failed: ${data.error ?? 'Unknown error'}`);
    }

    return { clientID: data.clientID, objs: data.objs[0] };
  }

  /**
   * Step 2: Authenticate with the clientID from login.
   * Returns a new clientID that must be used for all subsequent calls.
   */
  private async authenticate(loginClientID: string, objs: LoginObjs): Promise<string> {
    const body = {
      service: 'authenticate',
      clientID: loginClientID,
      COMPANY: objs.COMPANY,
      BRANCH: objs.BRANCH,
      MODULE: objs.MODULE,
      REFID: objs.REFID,
    };

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`SoftOne authenticate HTTP error: ${response.status} ${response.statusText}`);
    }

    const data = await this.readJson<AuthenticateResponse>(response);

    if (!data.success || !data.clientID) {
      throw new Error(`SoftOne authenticate failed: ${data.error ?? 'Unknown error'}`);
    }

    return data.clientID;
  }

  /**
   * Ensures a valid session exists. Uses cached session if still fresh,
   * otherwise performs login + authenticate. Deduplicates concurrent calls.
   */
  private async ensureSession(force = false): Promise<SoftOneSession> {
    if (!force && this.session && Date.now() - this.session.createdAt < SESSION_TTL_MS) {
      return this.session;
    }

    // Deduplicate concurrent session requests
    if (!this.sessionPromise || force) {
      this.sessionPromise = (async () => {
        try {
          logger.info('SoftOne WS: initiating login');

          const loginResult = await this.login();
          const authClientID = await this.authenticate(loginResult.clientID, loginResult.objs);

          const session: SoftOneSession = {
            clientID: authClientID,
            company: loginResult.objs.COMPANY,
            branch: loginResult.objs.BRANCH,
            module: loginResult.objs.MODULE,
            refid: loginResult.objs.REFID,
            createdAt: Date.now(),
          };

          this.session = session;
          logger.info('SoftOne WS: session established');
          return session;
        } catch (err) {
          this.session = null;
          this.sessionPromise = null;
          throw err;
        }
      })();
    }

    return this.sessionPromise;
  }

  // ── Service Calls ──────────────────────────────────────────────────────

  /**
   * Calls a service at the Additional Endpoint.
   * Automatically handles session management and retries on auth failure.
   */
  async callService<T>(
    serviceName: string,
    data: Record<string, unknown> = {},
  ): Promise<T> {
    const session = await this.ensureSession();

    const body = {
      service: serviceName,
      clientid: session.clientID,
      appid: this.config.appId,
      ...data,
    };

    const response = await fetch(this.config.apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`SoftOne ${serviceName} HTTP error: ${response.status} ${response.statusText}`);
    }

    const result = await this.readJson<T | ServiceErrorResponse>(response);

    // Check for auth-related errors and retry once with fresh session
    if (isServiceError(result)) {
      const isAuthError = result.errorcode === -1 || result.errorcode === -6 ||
        (result.error?.toLowerCase().includes('login') ?? false) ||
        (result.error?.toLowerCase().includes('invalid request') ?? false);

      if (isAuthError) {
        logger.warn('SoftOne WS: auth error, re-authenticating', {
          service: serviceName,
          error: result.error,
          errorcode: String(result.errorcode ?? ''),
        });

        // Force re-auth and retry once
        const freshSession = await this.ensureSession(true);

        const retryBody = {
          service: serviceName,
          clientid: freshSession.clientID,
          appid: this.config.appId,
          ...data,
        };

        const retryResponse = await fetch(this.config.apiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(retryBody),
        });

        if (!retryResponse.ok) {
          throw new Error(`SoftOne ${serviceName} retry HTTP error: ${retryResponse.status} ${retryResponse.statusText}`);
        }

        const retryResult = await this.readJson<T | ServiceErrorResponse>(retryResponse);

        if (isServiceError(retryResult)) {
          throw new Error(`SoftOne ${serviceName} failed after re-auth: ${retryResult.error}`);
        }

        return retryResult as T;
      }

      throw new Error(`SoftOne ${serviceName} failed: ${result.error}`);
    }

    return result as T;
  }

  // ── Typed Service Methods ──────────────────────────────────────────────

  /**
   * Creates a project in SoftOne ERP via the setProject web service.
   */
  async setProject(params: SetProjectParams): Promise<SetProjectResult> {
    const result = await this.callService<SetProjectResult>('setProject', params as unknown as Record<string, unknown>);

    if (!result.success) {
      throw new Error(`SoftOne setProject failed: ${(result as unknown as ServiceErrorResponse).error ?? 'Unknown error'}`);
    }

    return result;
  }

  /**
   * Creates one or more items in SoftOne ERP via the setItem web service.
   */
  async setItem(params: SetItemParams): Promise<SetItemResult> {
    const result = await this.callService<SetItemResult>('setItem', params as unknown as Record<string, unknown>);

    if (!result.success) {
      throw new Error(`SoftOne setItem failed: ${(result as unknown as ServiceErrorResponse).error ?? 'Unknown error'}`);
    }

    return result;
  }

  /**
   * Creates a document (order) with lines in SoftOne ERP via the setDocs web service.
   */
  async setDocs(params: SetDocsParams): Promise<SetDocsResult> {
    const result = await this.callService<SetDocsResult>('setDocs', params as unknown as Record<string, unknown>);

    if (!result.success) {
      throw new Error(`SoftOne setDocs failed: ${(result as unknown as ServiceErrorResponse).error ?? 'Unknown error'}`);
    }

    return result;
  }

  /**
   * Updates a project's status in SoftOne ERP via the updatePrjStatus web service.
   */
  async updatePrjStatus(params: UpdatePrjStatusParams): Promise<UpdatePrjStatusResult> {
    const result = await this.callService<UpdatePrjStatusResult>('updatePrjStatus', params as unknown as Record<string, unknown>);

    if (!result.success) {
      throw new Error(`SoftOne updatePrjStatus failed: ${(result as unknown as ServiceErrorResponse).error ?? 'Unknown error'}`);
    }

    return result;
  }

  /**
   * Tests the login + authenticate flow without calling any service.
   */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.ensureSession(true);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, error: message };
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isServiceError(result: unknown): result is ServiceErrorResponse {
  return (
    typeof result === 'object' &&
    result !== null &&
    'success' in result &&
    (result as { success: unknown }).success === false
  );
}

// ── Singleton ──────────────────────────────────────────────────────────────

let clientInstance: SoftOneClient | null = null;

/**
 * Returns a lazily-created singleton SoftOneClient.
 * Reads configuration from environment variables.
 */
export function getSoftOneClient(): SoftOneClient {
  if (!clientInstance) {
    const endpoint = process.env.SOFTONE_WS_ENDPOINT;
    const apiEndpoint = process.env.SOFTONE_WS_API_ENDPOINT;
    const username = process.env.SOFTONE_WS_USERNAME;
    const password = process.env.SOFTONE_WS_PASSWORD;
    const appId = process.env.SOFTONE_WS_APP_ID;

    if (!endpoint || !apiEndpoint || !username || !password || !appId) {
      throw new Error(
        'SoftOne WS configuration missing. Required env vars: ' +
        'SOFTONE_WS_ENDPOINT, SOFTONE_WS_API_ENDPOINT, SOFTONE_WS_USERNAME, SOFTONE_WS_PASSWORD, SOFTONE_WS_APP_ID',
      );
    }

    clientInstance = new SoftOneClient({ endpoint, apiEndpoint, username, password, appId });
  }

  return clientInstance;
}
