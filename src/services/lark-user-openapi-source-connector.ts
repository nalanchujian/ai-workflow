import type { NetworkClient, NetworkResponse } from '../ports/network-client.js';
import type { ConnectedDocumentSource, SourceConnector } from '../ports/source-connector.js';
import { larkBlocksPageFromResponse, LarkSourceConnectorError, parseLarkUrl, renderLarkBlocks, selectLarkSection, type LarkBlock } from './lark-source-connector.js';
import { LocalConfig, type LocalLarkConnectorProfile } from './local-config.js';
import { LarkUserOAuthService } from './lark-user-oauth-service.js';

/** Reads Lark Wiki and Docx documents directly through Lark OpenAPI as the authorized user. */
export class LarkUserOpenApiSourceConnector implements SourceConnector {
  constructor(private readonly deps: { config: LocalConfig; network: NetworkClient; oauth: LarkUserOAuthService }) {}

  supports(input: string): boolean {
    return parseLarkUrl(input) !== undefined;
  }

  async fetch(input: string, options: { section?: string } = {}): Promise<ConnectedDocumentSource> {
    const parsed = parseLarkUrl(input);
    if (parsed === undefined) throw new LarkSourceConnectorError('LARK_URL_UNSUPPORTED', '当前连接器不支持该文档类型');
    const profile = await this.profile();
    try {
      const accessToken = await this.deps.oauth.authorize();
      const documentId = parsed.kind === 'wiki' ? await this.resolveWikiDocument(profile, parsed.externalId, accessToken) : parsed.externalId;
      const blocks = await this.readBlocks(profile, documentId, accessToken);
      const selected = options.section === undefined ? undefined : selectLarkSection(blocks, options.section);
      const markdown = selected?.markdown ?? renderLarkBlocks(blocks);
      if (markdown.trim().length === 0) throw new LarkSourceConnectorError('LARK_RESPONSE_INVALID', 'Lark 返回了空文档');
      return {
        canonicalUrl: parsed.canonicalUrl,
        externalId: parsed.externalId,
        ...(parsed.kind === 'wiki' ? { resolvedExternalId: documentId } : {}),
        ...(selected === undefined ? {} : { section: selected.section }),
        fetchedAt: new Date().toISOString(),
        markdown,
        extractor: 'lark-user-openapi/v1',
      };
    } catch (error) {
      if (error instanceof LarkSourceConnectorError) throw error;
      throw new LarkSourceConnectorError('LARK_UNAVAILABLE', 'Lark 用户身份文档服务不可用');
    }
  }

  private async resolveWikiDocument(profile: LocalLarkConnectorProfile, nodeToken: string, accessToken: string): Promise<string> {
    const body = await this.request(profile, `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`, accessToken);
    const node = body.node;
    if (!isRecord(node) || node.obj_type !== 'docx' || typeof node.obj_token !== 'string' || node.obj_token.length === 0) {
      throw new LarkSourceConnectorError('LARK_URL_UNSUPPORTED', 'Wiki 节点不是可读取的 docx 文档');
    }
    return node.obj_token;
  }

  private async readBlocks(profile: LocalLarkConnectorProfile, documentId: string, accessToken: string): Promise<LarkBlock[]> {
    const blocks: LarkBlock[] = [];
    let pageToken: string | undefined;
    do {
      const parameters = new URLSearchParams({ document_revision_id: '-1', page_size: '500' });
      if (pageToken !== undefined) parameters.set('page_token', pageToken);
      const body = await this.request(profile, `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${parameters.toString()}`, accessToken);
      const page = larkBlocksPageFromResponse(body);
      blocks.push(...page.items);
      pageToken = page.hasMore ? page.nextPageToken : undefined;
    } while (pageToken !== undefined);
    return blocks;
  }

  private async request(profile: LocalLarkConnectorProfile, path: string, accessToken: string): Promise<Record<string, unknown>> {
    try {
      const response = await this.deps.network.fetch({
        url: `${profile.domain.replace(/\/$/, '')}${path}`,
        timeoutMs: 30_000,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return responseData(response);
    } catch (error) {
      if (error instanceof LarkSourceConnectorError) throw error;
      throw new LarkSourceConnectorError('LARK_UNAVAILABLE', 'Lark 用户身份文档服务不可用');
    }
  }

  private async profile(): Promise<LocalLarkConnectorProfile> {
    try {
      return await this.deps.config.larkConnector();
    } catch {
      throw new LarkSourceConnectorError('LARK_AUTH_EXPIRED', '未配置 Lark 用户身份，请运行 aiw lark login 完成授权');
    }
  }
}

function responseData(response: NetworkResponse): Record<string, unknown> {
  try {
    const body: unknown = JSON.parse(response.body);
    if (!isRecord(body)) throw new Error('invalid');
    if (body.code === 99991672) throw new LarkSourceConnectorError('LARK_AUTHORIZATION_DENIED', '当前用户未获授权读取该 Lark 文档');
    if (body.code !== 0 || !isRecord(body.data)) {
      if (response.status === 401 || [99991661, 99991663, 99991668].includes(body.code as number)) throw new LarkSourceConnectorError('LARK_AUTH_EXPIRED', '本次 Lark 用户授权已失效，请重新运行当前命令');
      throw new Error('invalid');
    }
    return body.data;
  } catch (error) {
    if (error instanceof LarkSourceConnectorError) throw error;
    throw new LarkSourceConnectorError('LARK_UNAVAILABLE', 'Lark 用户身份文档服务不可用');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
