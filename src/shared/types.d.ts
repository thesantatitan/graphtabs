export interface TabNode {
  id: number;
  title: string;
  url: string;
  windowId: number;
  openerTabId: number | null;
  active: boolean;
}

export interface TabEdge {
  from: number;
  to: number;
}

export interface TabGraph {
  nodes: TabNode[];
  edges: TabEdge[];
}

declare global {
  interface GraphUpdateMessage {
    type: 'graph:update';
    graph: TabGraph;
  }

  interface GraphGetRequest {
    type: 'graph:get';
  }

  interface GraphGetResponse {
    graph: TabGraph;
  }

  interface ThumbnailUpdateMessage {
    type: 'thumb:update';
    tabId: number;
    reason?: string;
  }

  interface ThumbnailGetRequest {
    type: 'thumb:get';
    tabId: number;
  }

  interface ThumbnailGetResponse {
    found: boolean;
    blocked: boolean;
    storageKey: string | null;
    lastUpdated: number | null;
  }

  interface TabActivateMessage {
    type: 'tab:activate';
    tabId: number;
  }

  interface TabCloseMessage {
    type: 'tab:close';
    tabId: number;
  }

  interface WindowFocusMessage {
    type: 'window:focus';
    windowId: number;
  }
}

export {};
