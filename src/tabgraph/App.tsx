import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react';
import { graphlib, layout as dagreLayout } from '@dagrejs/dagre';

import BrowserWindowNode, { type BrowserWindowNodeType } from './nodes/BrowserWindowNode';
import '@xyflow/react/dist/style.css';
import type { TabGraph } from '../shared/types';

type ThumbnailMap = Map<number, string | null>;

const DEFAULT_NODE_WIDTH = 360;
const DEFAULT_NODE_HEIGHT = 260;

const DAGRE_CONFIG = {
  rankdir: 'LR',
  nodesep: 80,
  ranksep: 160,
  marginx: 60,
  marginy: 60,
} as const;

const EXTENSION_AVAILABLE = typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;

const FALLBACK_GRAPH: TabGraph = {
  nodes: [
    {
      id: 1,
      title: 'GraphTabs Preview',
      url: 'https://example.com',
      windowId: 1,
      openerTabId: null,
      active: true,
    },
    {
      id: 2,
      title: 'Documentation',
      url: 'https://docs.example.com',
      windowId: 1,
      openerTabId: 1,
      active: false,
    },
  ],
  edges: [
    {
      from: 1,
      to: 2,
    },
  ],
};

function calculateLayout(graph: TabGraph, existingNodes: Map<string, BrowserWindowNodeType>) {
  const dagreGraph = new graphlib.Graph();
  dagreGraph.setGraph(DAGRE_CONFIG);
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  for (const tab of graph.nodes) {
    const id = tab.id.toString();
    const previous = existingNodes.get(id);
    const width = previous?.data?.width ?? DEFAULT_NODE_WIDTH;
    const height = previous?.data?.height ?? DEFAULT_NODE_HEIGHT;
    dagreGraph.setNode(id, { width, height });
  }

  for (const edge of graph.edges) {
    dagreGraph.setEdge(edge.from.toString(), edge.to.toString());
  }

  dagreLayout(dagreGraph);

  const positions = new Map<string, { x: number; y: number }>();
  for (const tab of graph.nodes) {
    const id = tab.id.toString();
    const node = dagreGraph.node(id);
    if (!node) continue;
    const width = node.width ?? DEFAULT_NODE_WIDTH;
    const height = node.height ?? DEFAULT_NODE_HEIGHT;
    positions.set(id, {
      x: node.x - width / 2,
      y: node.y - height / 2,
    });
  }

  return positions;
}

export default function App() {
  const nodeTypes = useMemo(() => ({ browserWindow: BrowserWindowNode }), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<BrowserWindowNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<BrowserWindowNodeType, Edge> | null>(null);
  const thumbnailsRef = useRef<ThumbnailMap>(new Map());
  const [layoutVersion, setLayoutVersion] = useState(0);

  const applyThumbnailsToNodes = useCallback(() => {
    setNodes((prevNodes) =>
      prevNodes.map((node) => {
        const tabId = Number(node.id);
        const nextThumb = thumbnailsRef.current.get(tabId) ?? null;
        const currentThumb = node.data?.imageSrc ?? null;
        if (nextThumb === currentThumb) {
          return node;
        }
        return {
          ...node,
          data: {
            ...node.data,
            imageSrc: nextThumb ?? undefined,
          },
        };
      })
    );
  }, [setNodes]);

  const updateFlowGraph = useCallback(
    (graph: TabGraph) => {
      const existingIds = new Set(graph.nodes.map((tab) => tab.id));
      for (const key of thumbnailsRef.current.keys()) {
        if (!existingIds.has(key)) {
          thumbnailsRef.current.delete(key);
        }
      }

      setNodes((previous) => {
        const existingMap = new Map(previous.map((node) => [node.id, node] as const));
        const positions = calculateLayout(graph, existingMap);

        return graph.nodes.map((tab) => {
          const id = tab.id.toString();
          const prior = existingMap.get(id);
          const width = prior?.data?.width ?? DEFAULT_NODE_WIDTH;
          const height = prior?.data?.height ?? DEFAULT_NODE_HEIGHT;
          const position = positions.get(id) ?? prior?.position ?? { x: 0, y: 0 };
          const thumb = thumbnailsRef.current.get(tab.id) ?? null;
          const title = tab.title?.trim() || tab.url || `Tab ${tab.id}`;

          return {
            id,
            type: 'browserWindow',
            position,
            data: {
              title,
              imageSrc: thumb ?? undefined,
              imageAlt: title ? `Preview of ${title}` : 'Browser node preview',
              width,
              height,
            },
          } satisfies BrowserWindowNodeType;
        });
      });

      setEdges(
        graph.edges.map(({ from, to }) => ({
          id: `${from}-${to}`,
          source: from.toString(),
          target: to.toString(),
          type: 'smoothstep',
        }))
      );

      setLayoutVersion((version) => version + 1);
    },
    [setEdges, setNodes]
  );

  const fetchThumbnail = useCallback(
    async (tabId: number) => {
      if (!EXTENSION_AVAILABLE) return;
      try {
        const response = await chrome.runtime.sendMessage<ThumbnailGetRequest, ThumbnailGetResponse>({
          type: 'thumb:get',
          tabId,
        });
        if (!response) return;

        let nextSrc: string | null = null;
        if (response.found && !response.blocked && response.storageKey) {
          const storageData = await chrome.storage.session.get(response.storageKey);
          const entry = storageData?.[response.storageKey];
          if (entry && typeof entry.dataUrl === 'string') {
            nextSrc = entry.dataUrl;
          }
        }

        thumbnailsRef.current.set(tabId, nextSrc);
        applyThumbnailsToNodes();
      } catch (error) {
        console.warn('fetchThumbnail failed', error);
      }
    },
    [applyThumbnailsToNodes]
  );

  const prefetchThumbnails = useCallback(
    (graph: TabGraph) => {
      if (!EXTENSION_AVAILABLE) return;
      const tasks = graph.nodes.map((tab) => fetchThumbnail(tab.id));
      void Promise.allSettled(tasks);
    },
    [fetchThumbnail]
  );

  useEffect(() => {
    if (!EXTENSION_AVAILABLE) {
      updateFlowGraph(FALLBACK_GRAPH);
      return;
    }

    let active = true;

    const handleRuntimeMessage = (message: unknown) => {
      if (!active || !message || typeof message !== 'object') return;
      const typed = message as GraphUpdateMessage | ThumbnailUpdateMessage;
      if (typed.type === 'graph:update') {
        updateFlowGraph(typed.graph);
        prefetchThumbnails(typed.graph);
      } else if (typed.type === 'thumb:update') {
        fetchThumbnail(typed.tabId);
      }
    };

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    chrome.runtime
      .sendMessage<GraphGetRequest, GraphGetResponse>({ type: 'graph:get' })
      .then((response) => {
        if (!active || !response?.graph) return;
        updateFlowGraph(response.graph);
        prefetchThumbnails(response.graph);
      })
      .catch((error) => {
        console.warn('graph:get failed', error);
      });

    return () => {
      active = false;
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    };
  }, [fetchThumbnail, prefetchThumbnails, updateFlowGraph]);

  useEffect(() => {
    if (!flowInstance || !layoutVersion) return;
    const handle = window.setTimeout(() => {
      try {
        flowInstance.fitView({ padding: 0.2, duration: 200 });
      } catch (error) {
        console.warn('fitView failed', error);
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, [flowInstance, layoutVersion, nodes.length]);

  const handleFlowInit = useCallback(
    (instance: ReactFlowInstance<BrowserWindowNodeType, Edge>) => {
      setFlowInstance(instance);
      try {
        instance.fitView({ padding: 0.2 });
      } catch (error) {
        console.warn('initial fitView failed', error);
      }
    },
    []
  );

  return (
    <div style={{ height: '98vh', width: '98vw' }}>
      <ReactFlow<BrowserWindowNodeType, Edge>
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onInit={handleFlowInit}
        nodesDraggable
        nodesConnectable={false}
        panOnScroll
        zoomOnPinch
        style={{ width: '100%', height: '100%' }}
      >
        <Background id="grid" gap={60} color="#cbd5e1" />
        <Controls />
      </ReactFlow>
    </div>
  );
}