import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Edge,
  type Connection,
} from '@xyflow/react';

import BrowserWindowNode, { type BrowserWindowNodeType } from './nodes/BrowserWindowNode';
import '@xyflow/react/dist/style.css';

const initialNodes: BrowserWindowNodeType[] = [
  {
    id: 'browser-1',
    type: 'browserWindow',
    position: { x: 250, y: 120 },
    data: {
      title: 'Marketing Landing Page',
      imageSrc:
        'https://images.unsplash.com/photo-1523475472560-d2df97ec485c?auto=format&fit=crop&w=800&q=80',
      imageAlt: 'Screenshot preview for a marketing site',
    },
  },
];

const initialEdges: Edge[] = [];

export default function App() {
  const nodeTypes = useMemo(() => ({ browserWindow: BrowserWindowNode }), []);
  const [nodes, , onNodesChange] = useNodesState<BrowserWindowNodeType>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((existing) => addEdge(connection, existing)),
    [setEdges]
  );

  return (
    <div style={{ height: '98vh', width: '98vw' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        style={{ width: '100%', height: '100%' }}
      >
        <Background id='grid' gap={50} color='#cbd5e1' />
        <Controls />
      </ReactFlow>
    </div>
  );
}