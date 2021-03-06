/*
Copyright 2019 Adobe
All Rights Reserved.

NOTICE: Adobe permits you to use, modify, and distribute this file in
accordance with the terms of the Adobe license agreement accompanying
it. If you have received this file from a source other than Adobe,
then your use, modification, or distribution of it requires the prior
written permission of Adobe.
*/
import "../common/ResizeObserver";
import ResizeObserver, { ResizeObserverEntry, UxpResizeObserver } from '../common/ResizeObserver';
import Rect from "../common/Rect";
import Margin from "../common/Margin";
import getStableArray from "./getStableArray";
import React, { ReactElement } from "react";

const initialVisibleItemCount = 30;

export type ItemProperty<T,V> = (item: T) => V

type ContainerProperties<T> = {
    container: HTMLDivElement
    items: T[]
    itemKey: ItemProperty<T,string>
    itemType: ItemProperty<T,string>
    itemRect?: ItemProperty<T,Rect>
    renderKeys: string[]
    setRenderKeys(value: string[]): void
}

/**
 * Used when scrolling to item with flow layout.
 * We don't really know the size of intervening items,
 * so we may have to correct scrollTop to keep item in view after sizing.
 */
type ScrollAnchor = {
    itemKey: string,
    itemPin: number, // 0 = top, 0.5 = middle, 1 = bottom
    windowPin: number, // 0 = top, 0.5 = middle, 1 = bottom
}

class ClassProperties {
    type!: string;
    cssInline!: boolean;
    cssMargin!: Margin;
    width!: number;
    height!: number;
    //  we mark this on all class properties after a container resize
    //  so we can try to reload them if we still have
    //  components of their class present
    valid: boolean = false;

    totalItemWidth = 0;
    totalItemHeight = 0;
    totalItemCount = 0;

    constructor(type: string) {
        this.type = type;
    }

    invalidate() {
        this.valid = false;
        this.totalItemCount = 0;
        this.totalItemWidth = 0;
        this.totalItemHeight = 0;
    }

    //  this function stores and tracks an average item size of this type.
    //  this helps us more accurately estimate scroll location when doing flow layout.
    setItemSize(width: number, height: number) {
        this.totalItemWidth += width;
        this.totalItemHeight += height;
        this.totalItemCount++;

        // recalculate width/height
        this.width = Math.round(this.totalItemWidth / this.totalItemCount);
        this.height = Math.round(this.totalItemHeight / this.totalItemCount);
    }
}

class ItemProperties implements Rect {
    x: number = 0;
    y: number = 0;
    width: number = 0;
    height: number = 0;
    type: string;
    constructor(type) {
        this.type = type;
    }
}

function isHTMLElement(node: Node): node is HTMLElement {
    return node != null && node.nodeType === 1;
}

//  returns a memoized pixel css position.
const px = (() => {
    const cache: string[] = []
    return (value: number) => {
        let cached = cache[value];
        if (cached === undefined) {
            cached = cache[value] = `${value}px`;
        }
        return cached;
    }
})();

/**
 * This represents state which we cache permanently on the container.
 * Changes to this DO NOT force a react re-render.
 * By contrast changes to our react state does force a re-render.
 */
export default class VirtualManager<T> {

    private resizeObserver: UxpResizeObserver
    private container: HTMLDivElement
    private items!: T[]
    private itemLookup: Map<string,T>
    private itemKey: ItemProperty<T,string>
    private itemType: ItemProperty<T,string>
    private itemRect?: ItemProperty<T,Rect>
    private renderKeys!: string[]
    private setRenderKeys!: (renderKeys: string[]) => void
    private itemProperties: { [key: string]: ItemProperties | undefined } = {}
    private classProperties = new Map<string,ClassProperties>();
    private containerPadding: Margin = new Margin(0)
    private placeholder: HTMLDivElement
    private containerWidth: number;
    private scrollAnchor: ScrollAnchor | null = null;

    constructor(props: ContainerProperties<T>) {
        this.container = props.container;
        this.containerWidth = this.container.clientWidth;
        this.container[VirtualManager.symbol] = this;
        this.itemLookup = new Map();
        this.itemKey = props.itemKey;
        this.itemType = props.itemType;
        this.itemRect = props.itemRect;
        this.onresize = this.onresize.bind(this);
        this.resizeObserver = new ResizeObserver(this.onresize);
        this.updateAndLayout = this.updateAndLayout.bind(this);
        this.container.addEventListener("scroll", (e) => {
            this.updateAndLayout();
        });
        this.placeholder = document.createElement("div");
        this.container.appendChild(this.placeholder);
        this.update(props);
    }

    update(props: ContainerProperties<T>) {
        this.items = props.items;
        this.renderKeys = props.renderKeys;
        this.setRenderKeys = props.setRenderKeys;

        if (!this.isScrolling) {
            // we skip these time consuming steps if we are scrolling.
            // since they will be done at the end of the call chain anyways.
            let checkForDuplicates = new Set<string>();
            for (let item of this.items) {
                let key = this.itemKey(item);
                if (checkForDuplicates.has(key)) {
                    console.error(`Duplicate items:`, this.itemLookup.get(key), item);
                    throw new Error(`Item keys must be unique. Found duplicate: ${key}`);
                }
                checkForDuplicates.add(key);
                this.itemLookup.set(key, item);
            }

            this.updateAndLayout(true);
        }

        return this.renderKeys;
    }

    public static getReactElements<T>(items: T[], renderKeys: string[], itemKey: ItemProperty<T,string>, itemType: ItemProperty<T,string>, factory: (item: T) => ReactElement, cache: any) {
        const itemsByKey: { [key: string]: T } = {};
        for (let item of items) {
            itemsByKey[itemKey(item)] = item;
        }
        return renderKeys.map((key, elementIndex) => {
            const elementKey = String(elementIndex);
            const item = itemsByKey[key];
            if (item == null) {
                // if the item is not found it may have been temporarily hidden
                // we will try to render it from cached element.
                const cached = cache[key];
                if (cached) {
                    return cached;
                }
                console.warn("item missing: ", { key, elementIndex, items })
                return null;
            }
            return cache[key] = React.cloneElement(factory(item), {
                key: elementKey,
                "data-key": key,
                "data-type": itemType(item),
            });
        })
    }

    getItemRect(item: T, key?: string): Rect | null {
        if (item != null) {
            let rect = this.itemRect != null ? this.itemRect(item) : null;
            if (rect != null) {
                if (rect.x == null || rect.y == null || rect.width == null || rect.height == null) {
                    throw new Error(`Item rect missing required properties (x,y,width,height): ${JSON.stringify(rect)}`)
                }
                return rect;
            }
            if (key == null) {
                key = this.itemKey(item);
            }
            if (key != null) {
                let props = this.itemProperties[key];
                if (props != null) {
                    return props;
                }
            }
        }
        return null;
    }

    isScrolling = false
    updateAndLayout(forceLayout = false) {
        this.isScrolling = true;
        let needsLayout = this.updateIndexes()
        this.ensureElementsObservedAndSized();
        if (needsLayout || forceLayout) {
            this.layoutChildren();
        }
        this.isScrolling = false;
    }

    private layoutChildren() {
        // create quick element lookup by key.
        let elementLookup = this.getElementLookupByKey();
        let x = 0, y = 0, width = this.containerWidth - this.containerPadding.horizontal, height = 0;
        function newLine() {
            x = 0;
            y = height;
        }

        // now iterate items
        for (let item of this.items) {
            let key = this.itemKey(item)!;
            let element = elementLookup.get(key);
            if (this.itemRect != null) {
                let rect = this.getItemRect(item, key)!;
                if (element) {
                    const { style } = element;
                    style.position = `absolute`;
                    style.left = px(rect.x);
                    style.top = px(rect.y);
                    style.width = px(rect.width);
                    style.height = px(rect.height);
                }
                height = rect.y + rect.height;
                continue;
            }

            let type = this.itemType(item)!;
            let properties = this.getItemProperties(key, type);
            let classProps = this.classProperties.get(type);
            if (!classProps) {
                console.warn("missing class properties: " + type);
                break;
            }
            let margin = classProps.cssMargin;
            let inline = classProps.cssInline;
            let elementWidth = properties.width + margin.horizontal;
            let elementHeight = properties.height + margin.vertical;
            let left: number, top: number;
            if (!inline || (x + elementWidth) > width) {
                newLine();
            }
            left = x + this.containerPadding.left;
            top = y + this.containerPadding.top;
            height = Math.max(height, y + elementHeight);
            if (inline) {
                x += elementWidth;
            }
            else {
                y += elementHeight;
            }
            // store on properties
            properties.x = left;
            properties.y = top;
            if (element) {
                // now absolutely position if there is an element
                const { style } = element;
                if (style.position !== "absolute") {
                    style.position = "absolute";
                }
                style.left = px(left);
                style.top = px(top);
                if (!inline) {
                    style.width = px(width - margin.horizontal);
                }
            }
        }

        this.correctForScrollAnchor();

        // increase the placeholders height to match our layed out height.
        this.placeholder.style.height = px(height);
    }

    private correctForScrollAnchor() {
        if (this.scrollAnchor != null) {
            let itemProps = this.itemProperties[this.scrollAnchor.itemKey];
            if (itemProps != null) {
                let currentOffset = itemProps.y;
                let targetOffset
                    = this.container.scrollTop
                    - itemProps.height * this.scrollAnchor.itemPin
                    + this.container.clientHeight * this.scrollAnchor.windowPin;
                let correction = targetOffset - currentOffset;
                if (correction === 0) {
                    this.scrollAnchor = null;
                }
                else {
                    this.container.scrollTop = this.container.scrollTop - correction;
                }
            }
        }
    }

    private getElementLookupByKey() {
        let elementLookup = new Map<string, HTMLElement>();
        let index = 0;
        for (let child: Node | null = this.container.firstChild; child != null; child = child.nextSibling) {
            if (isHTMLElement(child)) {
                let key = child.dataset.key;
                if (key) {
                    elementLookup.set(key, child);
                }
                else if (child.previousSibling != null) {
                    // the first child is the height placeholder element
                    // every other element should have a data-key property
                    // if not that means they used a function or class component
                    //  that is not passing ...otherProps to it's rendered element.
                    let item = this.items[index];
                    throw new Error(`Virtualizer item error: Function and Class components must pass through ...otherProps to rendered element. ie: <div {...otherProps}></div>. Check element created for ${JSON.stringify(item)}`);
                }
            }
            index++;
        }
        return elementLookup;
    }

    private static elementObserved = Symbol('elementObserved');
    private ensureElementsObservedAndSized() {
        this.resizeObserver.observe(this.container);
        for (let child: Node | null = this.container.firstChild; child != null; child = child.nextSibling) {
            if (child.nodeType === 1) {
                this.resizeObserver.observe(child as Element);
                // also make sure we've sized it if available.
                // Browser ResizeObserver does not send resize events for inline elements.
                this.onElementSized(child as HTMLElement);
            }
        }
    }

    get pageSize() {
        return this.container.clientHeight;
    }

    get prerenderOtherDirection() {
        return 100;
    }

    get prerenderScrollDirection() {
        return 500;
    }

    get isManualLayout() {
        return this.itemRect != null;
    }

    private getRenderItemIndices(scrollDirection: number) {
        let top = Math.max(0, this.container.scrollTop);
        let { pageSize, prerenderScrollDirection, prerenderOtherDirection } = this;
        if (scrollDirection === 0) {
            // if we aren't scrolling then each direction is other.
            prerenderScrollDirection = prerenderOtherDirection;
        }
        let bottom = top + pageSize;
        let totalPagesHeight = pageSize + prerenderScrollDirection + prerenderOtherDirection;
        // now expand top
        top = Math.max(0, top - (scrollDirection >= 0 ? prerenderOtherDirection : prerenderScrollDirection));
        // then expand bottom by whatever is remaining. (if this is larger than content area, that is fine)
        bottom = top + totalPagesHeight;

        const renderKeys = new Set<string>();
        const existingKeys = new Set<string>();
        // keys which we are adding so that we can pre-size them.
        // only used without manual layout.
        // This pre-sizing code ensures that we always contain at least one of each
        // item type in the document so that we can capture sizing and css class properties.
        const presize = !this.isManualLayout;
        const presizeTypes = presize ? new Map<string,string>() : null;

        for (let index = 0; index < this.items.length; index++) {
            const item = this.items[index];
            const key = this.itemKey(item);

            existingKeys.add(key);

            const rect = this.getItemRect(item, key);
            if (rect && ((rect.y + rect.height) > top) && (rect.y <= bottom)) {
                renderKeys.add(key);
            }
            else if (presizeTypes != null) {
                let type = this.itemType(item);
                if (!presizeTypes.has(type)) {
                    presizeTypes.set(type, key);
                }
            }
        }

        // we have to render *some* items since we may only get their accurate reported positions after they are rendered.
        if (renderKeys.size === 0) {
            for (let i = 0; i < initialVisibleItemCount && i < this.items.length; i++) {
                renderKeys.add(this.itemKey(this.items[i]))
            }
        }

        // we also want to always keep rendering a focused item so add this too
        const focusedKey = this.getFocusedItemKey();
        if (focusedKey) {
            renderKeys.add(focusedKey);
        }

        // finally, if we are pre-sizing elements we need to add some of each type.
        if (presizeTypes && presizeTypes.size > 0) {
            for (let key of presizeTypes.values()) {
                renderKeys.add(key);
            }
        }

        return [ renderKeys, existingKeys ];
    }

    private getFocusedItemKey() {
        for (let element: Node | null = document.activeElement; element != null; element = element.parentNode) {
            if (isHTMLElement(element)) {
                const key = element.dataset.key;
                if (key) {
                    return key;
                }
            }
        }
        return null;
    }

    private lastScrollTop: number = 0;
    private scrollDirection = 0; // 1 = down, -1 = up, 0 = none
    private previousItems?: T[]
    private updateIndexes() {
        if (this.pageSize === 0) {
            return;
        }

        // Clip scrollTop - UXP should do this automatically, but it doesn't due to bug UXP-10612
        // Can remove this once UXP bug is fixed
        const scrollHeight = this.container.scrollHeight;
        const scrollTop = Math.max(0, Math.min(this.container.scrollTop, scrollHeight - this.container.clientHeight));
        if (this.container.scrollTop !== scrollTop) {
            this.container.scrollTop = scrollTop;
        }

        const scrollDelta = scrollTop - this.lastScrollTop;
        this.lastScrollTop = scrollTop;

        const previousItems = this.previousItems || this.items;
        this.previousItems = this.items;
        const itemsProbablyChanged = this.items.length !== previousItems.length;
        if (itemsProbablyChanged) {
            this.scrollDirection = 0;
        }
        else if (scrollDelta !== 0) {
            this.scrollDirection = Math.sign(scrollDelta);
        }

        // Get a set of the items we want to render, and a set of all the items
        // (do this in one method, so we only need to iterate through all the items once)
        const [ renderKeys, existingKeys ] = this.getRenderItemIndices(this.scrollDirection);

        const getType = (key: string) => {
            if (key != null) {
                const item = this.itemLookup.get(key);
                if (item) {
                    return this.itemType(item);
                }
            }
            return null;
        };
        //  We use keys since even with additions/removals, keys are stable
        let oldKeys = this.renderKeys;
        let newKeys = getStableArray(
            oldKeys,
            renderKeys,
            getType,
            getType
        );
        const elementLookup = this.getElementLookupByKey();
        newKeys.forEach(key => {
            let element = elementLookup.get(key);
            if (element) {
                const deleted = !existingKeys.has(key);
                //  we HAVE to use display: none
                //  if we use visibility: hidden then the hidden elements
                //  still count for scroll size
                element.style.display = deleted ? "none" : "";
            }
        });

        // console.log({ existingKeys, renderKeys, newKeys })

        // we do a deep compare as we don't want to cause react re-rendering unless our rendered item renderKeys have changed.
        if (oldKeys.length !== newKeys.length || JSON.stringify(oldKeys) !== JSON.stringify(newKeys)) {
            // const debug = true;
            // if (debug) {
            //     let counts: any = {};
            //     for (let key of newKeys) {
            //         let type = getType(key)!;
            //         counts[type] = (counts[type] || 0) + 1;
            //     }
            //     console.log(JSON.stringify(counts, null, 2));
            // }
            this.setRenderKeys(newKeys);
            // this.renderKeys won't change till react re-renders and then calls VirtualManager.update().
            return true;
        }
        return false;
    }

    onElementSized(element: HTMLElement) {
        if (element === this.container) {
            this.containerPadding = Margin.fromCssPadding(getComputedStyle(element));
        }
        let { key, type } = element.dataset;
        if (key && type) {
            //  cache element size
            let properties = this.itemProperties[key];
            if (properties == null) {
                properties = this.getItemProperties(key, type);
            }
            // we REALLY only want to test these when absolutely necessary
            // since reading them forces immediate layout.
            const width = element.offsetWidth;
            const height = element.offsetHeight;
            if (width > 0 && height > 0) {
                let changed = (width !== properties.width || height !== properties.height);
                properties.width = width;
                properties.height = height;
                //  cache ComputedCssProperties by className
                if (changed) {
                    let classProps = this.classProperties.get(type);
                    if (classProps == null || !classProps.valid) {
                        let css = getComputedStyle(element);
                        if (classProps == null) {
                            classProps = new ClassProperties(type);
                            this.classProperties.set(type, classProps);
                        }
                        if (classProps.cssInline == null) {
                            //  we only record the first css display.
                            //  chrome is changing inline-block to block occasionally
                            //  this does mean clients cannot change display
                            //  with responsive media queries.
                            classProps.cssInline = (css.display || "").indexOf("inline") >= 0;
                        }
                        classProps.cssMargin = Margin.fromCssMargin(css)
                    }
                    classProps.setItemSize(width, height);
                }
            }
        }
    }

    private onresize(entries: ResizeObserverEntry[]) {
        //  if entries contains the container then we mark computed css obsolete
        //  that way we can recompute while traversing elements.
        for (let entry of entries) {
            if (entry.target === this.container) {
                this.containerWidth = this.container.clientWidth;
                for (let classProps of this.classProperties.values()) {
                    classProps.invalidate();
                }
                // also reset placeholder size
                this.placeholder.style.height = "0px";
                // TODO: Find currently visible items and use ScrollAnchor to restore them to same position after relayout.
                // also, clear all cached item sizes.
                for (let key in this.itemProperties) {
                    let itemProps = this.itemProperties[key]!;
                    itemProps.width = 0;
                    itemProps.height = 0;
                }
            }
            else {
                this.onElementSized(entry.target as HTMLElement);
            }
        }

        this.updateAndLayout(true);
    }

    scrollToItem(key: string, options?: { position?: number }) {
        let { container } = this;
        let item = this.itemLookup.get(key);
        if (item) {
            let itemPin = options?.position ?? 0;
            let windowPin = options?.position ?? 0;
            const bounds = this.getItemRect(item);
            if (bounds) {
                const manualLayout = this.isManualLayout;
                const clientHeight = container.clientHeight;
                const targetScrollTop = bounds.y - itemPin * bounds.height + windowPin * clientHeight;
                if (manualLayout) {
                    container.scrollTo({ top: targetScrollTop, behavior: "smooth" });
                }
                else {
                    // with custom layout we need to pin.
                    this.scrollAnchor = { itemKey: key, itemPin, windowPin }
                    container.scrollTo({ top: targetScrollTop });
                }
            }
        }
    }

    private static readonly symbol = Symbol("VirtualManager.symbol");
    private getItemProperties(key: string, type: string): ItemProperties {
        let props = this.itemProperties[key];
        if (props == null) {
            props = this.itemProperties[key] = new ItemProperties(type);
        }
        let classProps = this.classProperties.get(type);
        if (classProps) {
            if (props.width === 0) {
                props.width = classProps.width;
            }
            if (props.height === 0) {
                props.height = classProps.height;
            }
        }
        return props;
    }

    static instance<T>(container: HTMLElement): VirtualManager<T> | undefined
    static instance<T>(container: HTMLElement, props: ContainerProperties<T>): VirtualManager<T>
    static instance<T>(container: HTMLElement, props?: ContainerProperties<T>): VirtualManager<T> | undefined {
        let manager = container[VirtualManager.symbol];
        if (manager == null && props != null) {
            manager = new VirtualManager<T>(props);
        }
        return manager;
    }

    static update<T>(props: ContainerProperties<T>) {
        let manager = VirtualManager.instance<T>(props.container, props);
        manager.update(props);
        return manager.renderKeys;
    }

}
