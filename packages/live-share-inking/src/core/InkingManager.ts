/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the Microsoft Live Share SDK License.
 */

import { EventEmitter } from "events";
import { CanvasReferencePoint, InkingCanvas } from "../canvas/InkingCanvas";
import { DryCanvas, WetCanvas } from "../canvas/DryWetCanvas";
import { LaserPointerCanvas } from "../canvas/LaserPointerCanvas";
import { IPoint, IPointerPoint, makeRectangle, screenToViewport, viewportToScreen } from "./Geometry";
import { Stroke, IStroke, IStrokeCreationOptions, StrokeType } from "./Stroke";
import { InputFilter, InputFilterCollection } from "../input/InputFilter";
import { JitterFilter } from "../input/JitterFilter";
import { generateUniqueId, pointerEventToPoint } from "./Utils";
import { InputProvider } from "../input/InputProvider";
import { PointerInputProvider } from "../input/PointerInputProvider";
import { DefaultHighlighterBrush, DefaultLaserPointerBrush, DefaultPenBrush, IBrush } from "./Brush";

interface CoalescedPointerEvent extends PointerEvent {
    getCoalescedEvents(): PointerEvent[];
}

/**
 * @hidden
 * Retrieves a list of coalesced PointerEvent objects from a single PointerEvent.
 * PointerEvent.getCoalescedEvents() is an experimental feature and TypeScript doesn't
 * yet declare it.
 * For more info: https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents
 * @param event The PointerEvent to get coalesced events from.
 * @returns An array of coalesced PointerEvent objects.
 */
function getCoalescedEvents(event: PointerEvent): PointerEvent[] {
    if ('getCoalescedEvents' in event) {
        const events: PointerEvent[] = (event as CoalescedPointerEvent).getCoalescedEvents();

        // Firefox can return an empty list. See https://bugzilla.mozilla.org/show_bug.cgi?id=1511231.
        if (events.length >= 1) {
            return events;
        }
    }

    return [event];
}

/**
 * Defines available inking tools.
 */
export enum InkingTool {
    Pen,
    LaserPointer,
    Highlighter,
    Eraser,
    PointEraser
}

type StrokeBasedTool = InkingTool.Pen | InkingTool.LaserPointer | InkingTool.Highlighter;

/**
 * The event emitted by InkingManager when the canvas is cleared.
 */
export const ClearEvent: symbol = Symbol();
/**
 * The event emitted by InkingManager when a stroked is added.
 */
export const StrokesAddedEvent: symbol = Symbol();
/**
 * The event emitted by InkingManager when a stroked is removed.
 */
export const StrokesRemovedEvent: symbol = Symbol();

/**
 * Defines the arguments of the PointerMovedEvent.
 */
export interface IPointerMovedEventArgs {
    position?: IPoint;
}

/**
 * The event emitted by InkingManager when the pointer moves over the canvas.
 */
export const PointerMovedEvent: symbol = Symbol();

/**
 * Defines the arguments of the BeginStrokeEvent.
 */
export interface IBeginStrokeEventArgs {
    /**
     * The id of the new stroke.
     */
    strokeId: string;
    /**
     * The type of the new stroke.
     */
    type: StrokeType;
    /**
     * The brush of the new stroke.
     */
    brush: IBrush;
    /**
     * The starting point of the new stroke.
     */
    startPoint: IPointerPoint;
}

/**
 * The event emitted by InkingManager when a stroke begins.
 */
export const BeginStrokeEvent: symbol = Symbol();

export enum StrokeEndState {
    Ended,
    Cancelled
}

/**
 * Defines the arguments of the AddPointsEvent.
 */
export interface IAddPointsEventArgs {
    /**
     * The id of the stroke a point has been added to.
     */
    strokeId: string;
    /**
     * The points that were added to the stroke.
     */
    points: IPointerPoint[];
    /**
     * Indicates whether the stroke has ended (i.e. if the points
     * were the last ones.)
     */
    endState?: StrokeEndState;
}

/**
 * The event emitted by InkingManager when points are added to
 * the current stroke.
 */
export const AddPointsEvent: symbol = Symbol();

/**
 * Defines a "wet" stroke, i.e. a stroke as it's being drawn.
 */
export interface IWetStroke extends IStroke {
    /**
     * The type of the wet stroke.
     */
    readonly type: StrokeType;
    /**
     * Ends the wet stroke.
     * @param p Optional. The points at which the stroke ends. If not specified,
     * the stroke ends at the last added point.
     */
    end(p?: IPointerPoint): void;
    /**
     * Cancels the wet stroke.
     */
    cancel(): void;
}

class ChangeLog {
    private _addedStrokes: Map<string, IStroke> = new Map<string, IStroke>();
    private _removedStrokes: Set<string> = new Set<string>();

    public clear() {
        this._addedStrokes.clear();
        this._removedStrokes.clear();
    }

    public mergeChanges(changes: ChangeLog) {
        for (let id of changes._removedStrokes) {
            if (!this._addedStrokes.delete(id)) {
                this._removedStrokes.add(id);
            }
        }

        changes._addedStrokes.forEach(
            (value: IStroke) => {
                this._addedStrokes.set(value.id, value);
            });
    }

    public addStroke(stroke: IStroke) {
        this._addedStrokes.set(stroke.id, stroke);
    }

    public removeStroke(id: string) {
        this._removedStrokes.add(id);
    }

    public getRemovedStrokes(): string[] {
        return [...this._removedStrokes];
    }

    public getAddedStrokes(): IStroke[] {
        return [...this._addedStrokes.values()];
    }

    get hasChanges(): boolean {
        return this._addedStrokes.size > 0 || this._removedStrokes.size > 0;
    }
}

class EphemeralCanvas extends DryCanvas {
    private _removalTimeout?: number;

    constructor(readonly clientId: string, parentElement?: HTMLElement) {
        super(parentElement)
    }

    scheduleRemoval(onRemoveCallback: (canvas: EphemeralCanvas) => void) {
        if (this._removalTimeout) {
            window.clearTimeout(this._removalTimeout);
        }

        this._removalTimeout = window.setTimeout(
            () => {
                this.fadeOut();

                onRemoveCallback(this);
            },
            InkingManager.ephemeralCanvasRemovalDelay
        )

    }
}

/**
 * Defines options used by `InkingManager.addStroke` and `InkingManager.removeStroke`.
 */
export interface IAddRemoveStrokeOptions {
    /**
     * Optional. Indicates if the canvas must be fully re-rendered at once after the
     * stroke has been added or removed. Defaults to `false`.
     */
    forceReRender?: boolean,
    /**
     * Optional. Indicates whether the add or remove operation should be added to the
     * change log, which in turn will lead to `StrokeAddedEvent` or `StrokeRemovedEvent`
     * begin emitted. Defaults to `true`.
     */
    addToChangeLog?: boolean
}

/**
 * Handles user interaction with a canvas, and manages the rendering of wet and dry strokes.
 */
export class InkingManager extends EventEmitter {
    /**
     * The default client Id of the device running the application.
     */
    public static readonly localClientId = generateUniqueId();

    /**
     * Configures the delay between a request to render the canvas and the actual rendering.
     */
    public static asyncRenderDelay = 30;
    /**
     * Configures the amount of time to wait before processing eraser strokes. This delay allows
     * the collection of changes that can be handled as a batch.
     */
    public static pointEraserProcessingInterval = 30;
    /**
     * Configures the amount of time an ephemeral canvas (i.e. a canvas that renders ephemeral
     * strokes) takes to fade out.
     */
    public static ephemeralCanvasRemovalDelay = 1500;

    private static WetStroke = class extends Stroke implements IWetStroke {
        constructor(
            private _owner: InkingManager,
            private _canvas: InkingCanvas,
            readonly type: StrokeType,
            startPoint: IPointerPoint,
            options?: IStrokeCreationOptions) {
            super(options);

            this._canvas.setBrush(this.brush);
        }

        addPoints(...points: IPointerPoint[]): boolean {
            const currentLength = this.length;
            const result = super.addPoints(...points);

            if (result) {
                let startIndex = currentLength;

                if (startIndex === 0) {
                    this._canvas.beginStroke(this.getPointAt(0));

                    startIndex = 1;
                }

                for (let i = startIndex; i < this.length; i++) {
                    this._canvas.addPoint(this.getPointAt(i));
                }
            }

            return result;
        }

        end(p?: IPointerPoint) {
            this._canvas.removeFromDOM();
            this._canvas.endStroke(p);

            this._owner.wetStrokeEnded(this, false);

        }

        cancel() {
            this._canvas.removeFromDOM();
            this._canvas.cancelStroke();

            this._owner.wetStrokeEnded(this, true);
        }
    }

    private static ScreenToViewportCoordinateTransform = class extends InputFilter {
        constructor(private _owner: InkingManager) {
            super();
        }

        filterPoint(p: IPointerPoint): IPointerPoint {
            return {
                ...this._owner.screenToViewport(p),
                pressure: p.pressure
            };
        }
    }

    private readonly _host: HTMLElement;
    private readonly _canvasPoolHost: HTMLElement;
    private readonly _dryCanvas: InkingCanvas;
    private readonly _inputFilters: InputFilterCollection;

    private _penBrush: IBrush = { ...DefaultPenBrush };
    private _highlighterBrush: IBrush = { ...DefaultHighlighterBrush };
    private _laserPointerBrush: IBrush = { ...DefaultLaserPointerBrush }
    private _tool: InkingTool = InkingTool.Pen;
    private _activePointerId?: number;
    private _inputProvider!: InputProvider;
    private _currentStroke?: IWetStroke;
    private _strokes: Map<string, IStroke> = new Map<string, IStroke>();
    private _previousPoint?: IPointerPoint;
    private _reRenderTimeout?: number;
    private _pointEraseProcessingInterval?: number;
    private _pendingPointErasePoints: IPoint[] = [];
    private _changeLog: ChangeLog = new ChangeLog();
    private _isUpdating: boolean = false;
    private _hostResizeObserver: ResizeObserver;
    private _referencePoint: CanvasReferencePoint = "center";
    private _offset: Readonly<IPoint> = { x: 0, y: 0 };
    private _scale: number = 1;
    private _viewportWidth?: number;
    private _viewportHeight?: number;
    private _ephemeralCanvases: Map<string, EphemeralCanvas> = new Map<string, EphemeralCanvas>();

    private onHostResized = (entries: ResizeObserverEntry[], observer: ResizeObserver) => {
        this._viewportWidth = undefined;
        this._viewportHeight = undefined;

        if (entries.length >= 1) {
            const entry = entries[0];

            this._canvasPoolHost.style.width = entry.contentRect.width + "px";
            this._canvasPoolHost.style.height = entry.contentRect.height + "px";;

            this._dryCanvas.resize(entry.contentRect.width, entry.contentRect.height);

            // Re-render synchronously to avoid flicker
            this.reRender();
        }
    };

    private reRender() {
        this._dryCanvas.clear();

        this._dryCanvas.offset = this._offset;
        this._dryCanvas.scale = this._scale;

        const sortedStrokes = [...this._strokes.values()].sort(
            (stroke1: IStroke, stroke2: IStroke) => {
                return stroke1.timeStamp - stroke2.timeStamp
            }
        )

        for (const stroke of sortedStrokes) {
            this._dryCanvas.renderStroke(stroke);
        }
    }

    private scheduleReRender() {
        if (this._reRenderTimeout !== undefined) {
            window.clearTimeout(this._reRenderTimeout);
        }

        this._reRenderTimeout = window.setTimeout(
            () => {
                this.reRender();

                this._reRenderTimeout = undefined;
            },
            InkingManager.asyncRenderDelay);
    }

    private flushChangeLog() {
        if (this._changeLog.hasChanges) {
            this.notifyStrokesRemoved(...this._changeLog.getRemovedStrokes());
            this.notifyStrokesAdded(...this._changeLog.getAddedStrokes());

            this._changeLog.clear();
        }
    }

    private processPendingPointErasePoints() {
        for (let p of this._pendingPointErasePoints) {
            this.internalPointErase(p);
        }

        this._pendingPointErasePoints = [];
    }

    private schedulePointEraseProcessing() {
        if (this._pointEraseProcessingInterval === undefined) {
            this._pointEraseProcessingInterval = window.setTimeout(
                () => {
                    this.processPendingPointErasePoints();

                    this._pointEraseProcessingInterval = undefined;
                },
                InkingManager.pointEraserProcessingInterval);
        }
    }

    private getBrushForTool(tool: StrokeBasedTool): IBrush {
        switch (tool) {
            case InkingTool.LaserPointer:
                return this.laserPointerBrush;
            case InkingTool.Highlighter:
                return this.highlighterBrush;
            default:
                return this.penBrush;
        }
    }

    private capturePointer(pointerId: number) {
        this.releaseActivePointer();

        try {
            this._dryCanvas.canvas.setPointerCapture(pointerId);

            this._activePointerId = pointerId;
        }
        catch {
            // Ignore
        }
    }

    private releaseActivePointer() {
        if (this._activePointerId !== undefined) {
            this._dryCanvas.canvas.releasePointerCapture(this._activePointerId);
        }

        this._activePointerId = undefined;
    }

    private cancelCurrentStroke(p: IPointerPoint) {
        if (this._currentStroke !== undefined) {
            this._currentStroke.cancel();

            this.notifyEndStroke(this._currentStroke.id, p, true);

            this._currentStroke = undefined;
        }
    }

    private onPointerDown = (e: PointerEvent): void => {
        if (this._activePointerId === undefined) {
            this.capturePointer(e.pointerId);

            const p = pointerEventToPoint(e);

            this._inputFilters.reset(p);

            const filteredPoint = this._inputFilters.filterPoint(p);

            this.cancelCurrentStroke(filteredPoint);

            switch (this._tool) {
                case InkingTool.Pen:
                case InkingTool.Highlighter:
                case InkingTool.LaserPointer:
                    this._currentStroke = this.beginWetStroke(
                        this._tool === InkingTool.LaserPointer ? StrokeType.Ephemeral : StrokeType.Persistent,
                        filteredPoint,
                        {
                            brush: this.getBrushForTool(this._tool)
                        });

                    this.notifyBeginStroke(this._currentStroke);

                    break;
                case InkingTool.Eraser:
                    this.erase(filteredPoint);

                    break;
                case InkingTool.PointEraser:
                    this._pendingPointErasePoints.push(filteredPoint);

                    this.schedulePointEraseProcessing();

                    break;
            }

            this._previousPoint = filteredPoint;
        }

        e.preventDefault();
        e.stopPropagation();
    };

    private onPointerMove = (e: PointerEvent): void => {
        getCoalescedEvents(e).forEach(
            (evt: PointerEvent) => {
                const p = pointerEventToPoint(evt);

                // The laser pointer is displayed while hovering over the inking surface. We activate
                // it if there's not pointer captured
                if (this._activePointerId === undefined) {
                    if (this._tool === InkingTool.LaserPointer) {
                        if (this._currentStroke === undefined) {
                            this._inputFilters.reset(p);

                            const filteredPoint = this._inputFilters.filterPoint(p);

                            this._currentStroke = this.beginWetStroke(
                                StrokeType.LaserPointer,
                                filteredPoint,
                                {
                                    brush: this.getBrushForTool(this._tool)
                                });

                            this.notifyBeginStroke(this._currentStroke);
                        }
                        else {
                            const filteredPoint = this._inputFilters.filterPoint(p);

                            this._currentStroke.addPoints(filteredPoint);

                            this.notifyAddPoints(this._currentStroke.id, filteredPoint);
                        }
                    }
                    else {
                        const filteredPoint = this._inputFilters.filterPoint(p);

                        this.notifyPointerMoved(filteredPoint);
                    }
                }

                // Otherwise, we handle the pointer move event only if the pointer it comes
                // from is the one we have captured
                if (this._activePointerId === e.pointerId) {
                    const filteredPoint = this._inputFilters.filterPoint(p);

                    switch (this._tool) {
                        case InkingTool.Pen:
                        case InkingTool.Highlighter:
                        case InkingTool.LaserPointer:
                            if (this._currentStroke) {
                                this._currentStroke.addPoints(filteredPoint);

                                this.notifyAddPoints(this._currentStroke.id, filteredPoint);
                            }

                            break;
                        case InkingTool.Eraser:
                            this.erase(filteredPoint);

                            break;
                        case InkingTool.PointEraser:
                            // TODO: insert additional eraser points between the previous
                            // one and the new one to mitigate wide gaps between erased areas
                            // when the pointer moves fast
                            this._pendingPointErasePoints.push(filteredPoint);

                            this.schedulePointEraseProcessing();

                            break;
                    }

                    this._previousPoint = filteredPoint;
                }
            });

        e.preventDefault();
        e.stopPropagation();
    };

    private onPointerUp = (e: PointerEvent): void => {
        if (this._activePointerId === e.pointerId) {
            this.releaseActivePointer();

            const filteredPoint = this._inputFilters.filterPoint(pointerEventToPoint(e));

            switch (this._tool) {
                case InkingTool.Pen:
                case InkingTool.Highlighter:
                case InkingTool.LaserPointer:
                    if (this._currentStroke) {
                        this._currentStroke.end(filteredPoint);

                        this.notifyEndStroke(this._currentStroke.id, filteredPoint);

                        this._currentStroke = undefined;
                    }

                    break;
            }

            this.flushChangeLog();

            this._previousPoint = undefined;
            this._activePointerId = undefined;
        }

        e.preventDefault();
        e.stopPropagation();
    };

    private onPointerLeave = (e: PointerEvent): void => {
        if (this._activePointerId === undefined) {
            if (this._tool === InkingTool.LaserPointer) {
                const filteredPoint = this._inputFilters.filterPoint(pointerEventToPoint(e));

                this.cancelCurrentStroke(filteredPoint);
            }
            else {
                this.notifyPointerMoved();
            }
        }

        e.preventDefault();
        e.stopPropagation();
    }

    private internalAddStroke(stroke: IStroke, options?: IAddRemoveStrokeOptions) {
        const effectiveOptions: Required<IAddRemoveStrokeOptions> = {
            forceReRender: options ? (options.forceReRender ?? false) : false,
            addToChangeLog: options ? (options.addToChangeLog ?? true) : true
        };

        if (effectiveOptions.forceReRender || this._strokes.has(stroke.id)) {
            this._strokes.set(stroke.id, stroke);

            effectiveOptions.forceReRender ? this.reRender() : this.scheduleReRender();
        }
        else {
            this._strokes.set(stroke.id, stroke);
            this._dryCanvas.renderStroke(stroke);
        }

        if (effectiveOptions.addToChangeLog) {
            this._changeLog.addStroke(stroke);
        }
    }

    private wetStrokeEnded(stroke: IWetStroke, isCancelled: boolean) {
        if (!isCancelled) {
            if (stroke.type === StrokeType.Ephemeral) {
                const effectiveClientId = stroke.clientId ?? InkingManager.localClientId;

                let ephemeralCanvas = this._ephemeralCanvases.get(effectiveClientId);

                if (!ephemeralCanvas) {
                    ephemeralCanvas = new EphemeralCanvas(effectiveClientId, this._canvasPoolHost);
                    ephemeralCanvas.offset = this.offset;
                    ephemeralCanvas.scale = this.scale;
            
                    this._ephemeralCanvases.set(effectiveClientId, ephemeralCanvas);
                }

                ephemeralCanvas.renderStroke(stroke);

                ephemeralCanvas.scheduleRemoval(
                    (sender: EphemeralCanvas) => {
                        this._ephemeralCanvases.delete(sender.clientId);
                    }
                );
            }

            if (stroke.type === StrokeType.Persistent && !isCancelled) {
                this.internalAddStroke(stroke);
            }
        }
    }

    private internalErase(p: IPoint): ChangeLog {
        const result = new ChangeLog();
        const eraserRect = makeRectangle(p, this.eraserSize, this.eraserSize);

        this._strokes.forEach(
            (stroke: IStroke) => {
                if (stroke.intersectsWithRectangle(eraserRect)) {
                    result.removeStroke(stroke.id);
                }
            }
        )

        if (result.hasChanges) {
            result.getRemovedStrokes().forEach(
                (id: string) => {
                    this._strokes.delete(id);
                });

            this.scheduleReRender();

            this._changeLog.mergeChanges(result);
        }

        return result;
    }

    private internalPointErase(p: IPoint): ChangeLog {
        const result = new ChangeLog();
        const eraserRect = makeRectangle(p, this.eraserSize, this.eraserSize);

        this._strokes.forEach(
            (stroke: IStroke) => {
                const strokes = stroke.pointErase(eraserRect);

                if (strokes) {
                    result.removeStroke(stroke.id);

                    for (const s of strokes) {
                        result.addStroke(s);
                    }
                }
            }
        );

        if (result.hasChanges) {
            result.getRemovedStrokes().forEach(
                (id: string) => {
                    this._strokes.delete(id);
                });

            result.getAddedStrokes().forEach(
                (stroke: IStroke) => {
                    this._strokes.set(stroke.id, stroke);
                });

            this.scheduleReRender();

            this._changeLog.mergeChanges(result);
        }

        return result;
    }

    private notifyPointerMoved(position?: IPoint) {
        const eventArgs: IPointerMovedEventArgs = {
            position
        };

        this.emit(PointerMovedEvent, eventArgs);
    }

    private notifyStrokesAdded(...strokes: IStroke[]) {
        if (strokes.length > 0) {
            this.emit(StrokesAddedEvent, strokes);
        }
    }

    private notifyStrokesRemoved(...strokeIds: string[]) {
        if (strokeIds.length > 0) {
            this.emit(StrokesRemovedEvent, strokeIds);
        }
    }

    private notifyClear() {
        this.emit(ClearEvent);
    }

    private notifyBeginStroke(stroke: IWetStroke) {
        const eventArgs: IBeginStrokeEventArgs = {
            strokeId: stroke.id,
            brush: stroke.brush,
            startPoint: stroke.getPointAt(0),
            type: stroke.type
        }

        this.emit(BeginStrokeEvent, eventArgs);
    }

    protected notifyAddPoints(strokeId: string, ...points: IPointerPoint[]) {
        const eventArgs: IAddPointsEventArgs = {
            strokeId,
            points
        }

        this.emit(AddPointsEvent, eventArgs);
    }

    private notifyEndStroke(strokeId: string, endPoint?: IPointerPoint, isCancelled: boolean = false) {
        const eventArgs: IAddPointsEventArgs = {
            strokeId,
            points: endPoint ? [ endPoint ] : [],
            endState: isCancelled ? StrokeEndState.Cancelled : StrokeEndState.Ended
        }

        this.emit(AddPointsEvent, eventArgs);
    }

    /**
     * The size of the eraser.
     */
    public eraserSize: number = 20;

    /**
     * Creates a new InkingManager instance.
     * @param host The HTML element to host the canvases and other DOM elements handled by
     * the InkingManager instance. The `host` element shouldn't have any children. The
     * InkingManager instance might change its attributes, including its style.
     */
    constructor(host: HTMLElement) {
        super();

        this._inputFilters = new InputFilterCollection(
            new JitterFilter(),
            new InkingManager.ScreenToViewportCoordinateTransform(this));

        this._host = host;
        this._host.style.position = "relative";

        this._dryCanvas = new DryCanvas(this._host);

        this._canvasPoolHost = document.createElement("div");
        this._canvasPoolHost.style.position = "absolute";
        this._canvasPoolHost.style.pointerEvents = "none";

        this._host.appendChild(this._canvasPoolHost);

        this._inputProvider = new PointerInputProvider(this._dryCanvas.canvas);

        this._hostResizeObserver = new ResizeObserver(this.onHostResized);
        this._hostResizeObserver.observe(this._host);
    }

    /**
     * Temporarily blocks the emission of `StrokesAddedEvent` and `StrokesRemovedEvents` in order
     * to batch updates (via `addStroke` and `removeStroke`) into the change log. Once the
     * updates are done, `endUpdate` must be called.
     */
    public beginUpdate() {
        this._isUpdating = true;
    }

    /**
     * Unblocks the emission of update events and flushes the change log, leading to a single
     * `StrokesAddedEvent` and/or a single `StrokesRemovedEvent`.
     */
    public endUpdate() {
        if (this._isUpdating) {
            this._isUpdating = false;

            this.flushChangeLog();
        }
    }

    /**
     * Starts listening to pointer input.
     */
    public activate(): void {
        this._inputProvider.activate();

        this._inputProvider.on(InputProvider.PointerDown, this.onPointerDown);
        this._inputProvider.on(InputProvider.PointerMove, this.onPointerMove);
        this._inputProvider.on(InputProvider.PointerUp, this.onPointerUp);
        this._inputProvider.on(InputProvider.PointerLeave, this.onPointerLeave);
    }

    /**
     * Stops listening to pointer input.
     */
    public deactivate(): void {
        this._inputProvider.deactivate();

        this._inputProvider.off(InputProvider.PointerDown, this.onPointerDown);
        this._inputProvider.off(InputProvider.PointerMove, this.onPointerMove);
        this._inputProvider.off(InputProvider.PointerUp, this.onPointerUp);
        this._inputProvider.off(InputProvider.PointerLeave, this.onPointerLeave);
    }

    /**
     * Clears the canvas.
     */
    public clear() {
        this._strokes.clear();

        this.scheduleReRender();

        this.notifyClear();
    }

    /**
     * Starts a new wet stroke which will be drawn progressively on the canvas. Multiple wet strokes
     * can be created at the same time and will not interfere with each other.
     * @param strokeType The type of the stroke to start.
     * @param startPoint The starting point of the stroke.
     * @param options Creation options, such as is, points, brush...
     * @returns An IWetStroke object representing the ongoing stroke.
     */
    public beginWetStroke(strokeType: StrokeType, startPoint: IPointerPoint, options?: IStrokeCreationOptions): IWetStroke {
        const canvas = strokeType === StrokeType.LaserPointer ? new LaserPointerCanvas(this._canvasPoolHost) : new WetCanvas(this._canvasPoolHost);
        canvas.resize(this.viewportWidth, this.viewportHeight);
        canvas.offset = this.offset;
        canvas.scale = this.scale;

        const stroke = new InkingManager.WetStroke(
            this,
            canvas,
            strokeType,
            startPoint,
            options);

        stroke.addPoints(startPoint);

        return stroke;
    }

    /**
     * Retrieves an existing stroke from the drawing.
     * @param id The id of the stroke to retrieve.
     * @returns The stroke with the specified id.
     */
    public getStroke(id: string): IStroke | undefined {
        return this._strokes.get(id);
    }

    /**
     * Adds a stroke to the drawing.
     * @param stroke The stroke to add. If a stroke with the same id already exists
     * in the drawing, is it replaced.
     * @param options Options allowing the caller to force a re-render and/or bock the
     * emission of `StrokesAddedEvent`.
     */
    public addStroke(stroke: IStroke, options?: IAddRemoveStrokeOptions) {
        this.internalAddStroke(stroke, options);

        if (!this._isUpdating) {
            this.flushChangeLog();
        }
    }

    /**
     * Removes a stroke from the drawing.
     * @param id The id of the stroke to remove. If the stroke doesn't exist, nothing
     * happens.
     * @param options Options allowing the caller to force a re-render and/or bock the
     * emission of `StrokesRemovedEvent`.
     */
    public removeStroke(id: string, options?: IAddRemoveStrokeOptions) {
        if (this._strokes.delete(id)) {
            const effectiveOptions: Required<IAddRemoveStrokeOptions> = {
                forceReRender: options ? (options.forceReRender ?? false) : false,
                addToChangeLog: options ? (options.addToChangeLog ?? true) : true
            };

            effectiveOptions.forceReRender ? this.reRender() : this.scheduleReRender();

            if (effectiveOptions.addToChangeLog) {
                this._changeLog.removeStroke(id);
            }

            if (!this._isUpdating) {
                this.flushChangeLog();
            }
        }
    }

    /**
     * Entirely removes any strokes that intersect with the eraser rectangle.
     * @param p The center of the eraser rectangle. The size of the rectangle is
     * determined by the `eraserSize` property.
     */
    public erase(p: IPoint) {
        const result = this.internalErase(p);

        if (!this._isUpdating) {
            this.flushChangeLog();
        }
    }

    /**
     * Erases portions os strokes that intersect with the eraser rectangle.
     * @param p The center of the eraser rectangle. The size of the rectangle is
     * determined by the `eraserSize` property.
     */
    public pointErase(p: IPoint) {
        const result = this.internalPointErase(p);

        if (!this._isUpdating) {
            this.flushChangeLog();
        }
    }

    /**
     * Converts screen coordinates to viewport coordinates.
     * @param p The point to convert.
     * @returns The converted point.
     */
    public screenToViewport(p: IPoint): IPoint {
        return screenToViewport(
            p,
            this.referencePoint === "center"
                ? { x: this.viewportWidth / 2, y: this.viewportHeight / 2 }
                : { x: 0, y: 0 },
            this.offset,
            this.scale);
    }

    /**
     * Converts viewport coordinates to screen coordinates.
     * @param p The point to convert.
     * @returns The converted point.
     */
    public viewportToScreen(p: IPoint): IPoint {
        return viewportToScreen(
            p,
            this.referencePoint === "center"
                ? { x: this.viewportWidth / 2, y: this.viewportHeight / 2 }
                : { x: 0, y: 0 },
            this.offset,
            this.scale);
    }

    /**
     * Gets the pen brush.
     */
    get penBrush(): IBrush {
        return this._penBrush;
    }

    /**
     * Sets the pen brush.
     */
    set penBrush(value: IBrush) {
        this._penBrush = { ...value };
    }

    /**
     * Gets the highlighter brush.
     */
    get highlighterBrush(): IBrush {
        return this._highlighterBrush;
    }

    /**
     * Sets the highlighter brush.
     */
    set highlighterBrush(value: IBrush) {
        this._highlighterBrush = { ...value };
    }

    /**
     * Gets the laser pointer brush.
     */
    get laserPointerBrush(): IBrush {
        return this._laserPointerBrush;
    }

    /**
     * Sets the laser pointer brush.
     */
    set laserPointerBrush(value: IBrush) {
        this._laserPointerBrush = { ...value };
    }

    /**
     * Gets the width of the viewport.
     */
    get viewportWidth(): number {
        if (!this._viewportWidth) {
            this._viewportWidth = this._host.clientWidth;
        }

        return this._viewportWidth;
    }

    /**
     * Gets the height of the viewport.
     */
    get viewportHeight(): number {
        if (!this._viewportHeight) {
            this._viewportHeight = this._host.clientHeight;
        }

        return this._viewportHeight;
    }

    /**
     * Gets the current tool. Defaults to `InkingTool.Pen`.
     */
    get tool(): InkingTool {
        return this._tool;
    }

    /**
     * Sets the current tool.
     */
    set tool(value: InkingTool) {
        if (this._tool !== value) {
            if (this._currentStroke !== undefined) {
                this._currentStroke.cancel();
            }

            this._tool = value;
        }
    }

    /**
     * Gets the reference point. Defaults to "center".
     */
    get referencePoint(): CanvasReferencePoint {
        return this._referencePoint;
    }

    /**
     * Sets the reference point.
     */
    set referencePoint(value: CanvasReferencePoint) {
        if (this._referencePoint !== value) {
            this._referencePoint = value;

            this.reRender();
        }
    }

    /**
     * Gets the viewport offset. Defaults to 0,0.
     */
    get offset(): Readonly<IPoint> {
        return this._offset;
    }

    /**
     * Sets the viewport offset.
     */
    set offset(value: IPoint) {
        if (this._offset != value) {
            this._offset = { ...value };

            this.reRender();
        }
    }

    /**
     * Gets the scale. Defaults to 1.
     */
    get scale(): number {
        return this._scale;
    }

    /**
     * Sets the scale. Value must be greatwer than 0.
     */
    set scale(value: number) {
        if (this._scale !== value && value > 0) {
            this._scale = value;

            this.reRender();
        }
    }
}