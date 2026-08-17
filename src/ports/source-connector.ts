export interface ConnectedDocumentSource {
  canonicalUrl: string;
  externalId: string;
  resolvedExternalId?: string;
  section?: { title: string; startBlockId: string; endBlockId: string };
  title?: string;
  markdown: string;
  fetchedAt: string;
  extractor: string;
}

export interface SourceConnector {
  supports(reference: string): boolean;
  fetch(reference: string, options?: { section?: string }): Promise<ConnectedDocumentSource>;
}
