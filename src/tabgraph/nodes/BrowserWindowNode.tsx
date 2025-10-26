import { memo, useCallback, useMemo, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position, type Node, type NodeProps, useReactFlow } from '@xyflow/react';

export type BrowserWindowNodeData = {
  title?: string;
  imageSrc?: string;
  imageAlt?: string;
  hideHandles?: boolean;
  width?: number;
  height?: number;
};

export type BrowserWindowNodeType = Node<BrowserWindowNodeData, 'browserWindow'>;

type TabCloseResponse = {
  ok: boolean;
  error?: string;
};

function BrowserWindowNode({ id, data }: NodeProps<BrowserWindowNodeType>) {
  const { setNodes } = useReactFlow();
  const activeHandleRef = useRef<HTMLDivElement | null>(null);

  const MIN_WIDTH = 160;
  const MIN_HEIGHT = 150;
  const MIN_PREVIEW_HEIGHT = 120;
  const nodeData = useMemo(() => (data ?? {}) as BrowserWindowNodeData, [data]);
  const {
    title = 'Browser Preview',
    imageSrc,
    imageAlt = 'Browser node preview',
    hideHandles,
    width: dataWidth,
    height: dataHeight,
  } = nodeData;

  const width = Math.max(dataWidth ?? 260, MIN_WIDTH);
  const height = Math.max(dataHeight ?? 210, MIN_HEIGHT);
  const headerHeight = 30;
  const previewHeight = Math.max(height - headerHeight, MIN_PREVIEW_HEIGHT);
  const controlSpacing = Math.min(Math.max(width * 0.04, 6), 16);

  const handleCloseClick = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();

      const tabId = Number(id);
      const extensionAvailable = typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;

      if (extensionAvailable && Number.isFinite(tabId)) {
        try {
          const response = await chrome.runtime.sendMessage<TabCloseMessage, TabCloseResponse>({
            type: 'tab:close',
            tabId,
          });

          if (response?.ok) {
            setNodes((nodes) => nodes.filter((node) => node.id !== id));
          } else if (response && !response.ok) {
            console.warn('tab:close responded without closing the tab', response.error);
          }
        } catch (error) {
          console.warn('tab:close message failed', error);
        }
        return;
      }

      setNodes((nodes) => nodes.filter((node) => node.id !== id));
    },
    [id, setNodes]
  );

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const initialPointer = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: width,
        startHeight: height,
      };

      const onPointerMove = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - initialPointer.startX;
        const deltaY = moveEvent.clientY - initialPointer.startY;
  const nextWidth = Math.max(initialPointer.startWidth + deltaX, MIN_WIDTH);
  const nextHeight = Math.max(initialPointer.startHeight + deltaY, MIN_HEIGHT);

        setNodes((nodes) =>
          nodes.map((node) =>
            node.id === id
              ? {
                  ...node,
                  data: {
                    ...(node.data ?? {}),
                    width: nextWidth,
                    height: nextHeight,
                  },
                }
              : node
          )
        );
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== initialPointer.pointerId) {
          return;
        }

        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);

        if (activeHandleRef.current && activeHandleRef.current.hasPointerCapture(initialPointer.pointerId)) {
          activeHandleRef.current.releasePointerCapture(initialPointer.pointerId);
        }

        activeHandleRef.current = null;
      };

      const handleElement = event.currentTarget;
      activeHandleRef.current = handleElement;
      handleElement.setPointerCapture?.(event.pointerId);

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp, { once: false });
      window.addEventListener('pointercancel', onPointerUp, { once: false });
    },
    [height, id, setNodes, width]
  );

  return (
    <div
      style={{
        width,
        height,
        position: 'relative',
        borderRadius: 12,
        border: '1px solid #d0d5dd',
        boxShadow: '0 12px 30px rgba(15, 23, 42, 0.12)',
        background: '#ffffff',
  overflow: 'hidden',
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: 14,
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
          padding: '0.45rem 0.85rem',
          background: 'linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)',
          borderBottom: '1px solid #d0d5dd',
          minHeight: headerHeight,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: controlSpacing,
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
            fontSize: 20,
            fontWeight: 500,
            color: '#334155',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </div>
        <button
          onClick={handleCloseClick}
          aria-label="Close browser preview"
          style={{
            background: '#e2e8f0',
            border: '1px solid #cbd5f5',
            borderRadius: 4,
            width: 16,
            height: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#334155',
            cursor: 'pointer',
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      <div
        style={{
          width: '100%',
          height: previewHeight,
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
              fontSize: 16,
              fontWeight: 500,
            }}
          >
            No preview image
          </div>
        )}
      </div>

      <div
        onPointerDown={handleResizePointerDown}
        style={{
          position: 'absolute',
          right: 6,
          bottom: 6,
          width: 16,
          height: 16,
          borderRight: '2px solid rgba(148, 163, 184, 0.8)',
          borderBottom: '2px solid rgba(148, 163, 184, 0.8)',
          cursor: 'nwse-resize',
          background: 'transparent',
        }}
        role="presentation"
        aria-hidden="true"
      />
    </div>
  );
}

export default memo(BrowserWindowNode);
