import { memo, useCallback, type MouseEvent } from 'react';
import { Handle, Position, type Node, type NodeProps, useReactFlow } from '@xyflow/react';

export type BrowserWindowNodeData = {
  title?: string;
  imageSrc?: string;
  imageAlt?: string;
  hideHandles?: boolean;
};

export type BrowserWindowNodeType = Node<BrowserWindowNodeData, 'browserWindow'>;

function BrowserWindowNode({ id, data }: NodeProps<BrowserWindowNodeType>) {
  const { setNodes } = useReactFlow();

  const handleCloseClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // Prevent the click from dragging/selecting the node before removing it
      event.stopPropagation();
      setNodes((nodes) => nodes.filter((node) => node.id !== id));
    },
    [id, setNodes]
  );

  const nodeData = (data ?? {}) as BrowserWindowNodeData;
  const { title = 'Browser Preview', imageSrc, imageAlt = 'Browser node preview', hideHandles } = nodeData;

  return (
    <div
      style={{
        width: 260,
        borderRadius: 12,
        border: '1px solid #d0d5dd',
        boxShadow: '0 12px 30px rgba(15, 23, 42, 0.12)',
        background: '#ffffff',
        overflow: 'hidden',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      {!hideHandles && (
        <>
          <Handle type="target" position={Position.Left} style={{ top: '50%' }} />
          <Handle type="source" position={Position.Right} style={{ top: '50%' }} />
        </>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.5rem 0.75rem',
          background: 'linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)',
          borderBottom: '1px solid #d0d5dd',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#facc15', display: 'inline-block' }} />
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
        </div>
        <div
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 12,
            fontWeight: 500,
            color: '#475569',
          }}
        >
          {title}
        </div>
        <button
          onClick={handleCloseClick}
          aria-label="Close browser preview"
          style={{
            background: '#f1f5f9',
            border: '1px solid #cbd5f5',
            borderRadius: 6,
            width: 24,
            height: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#475569',
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>

      <div
        style={{
          width: '100%',
          height: 160,
          background: '#f8fafc',
          position: 'relative',
        }}
      >
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={imageAlt}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#94a3b8',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            No preview image
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(BrowserWindowNode);
