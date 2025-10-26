import { ReactFlow, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

export default function App() {
  return (
    <div style={{ height: '98vh', width: '98vw' }}>
      <ReactFlow style={{ width: '100%', height: '100%' }}>
        <Background id='1' gap={50} color='#000' />
        <Controls />
      </ReactFlow>
    </div>
  );
}