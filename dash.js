// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    Gio,
    GLib,
    GObject,
    Meta,
    Pango,
    Shell,
    St,
} from './dependencies/gi.js';

import {
    AppDisplay,
    AppFavorites,
    Dash,
    DND,
    Main,
} from './dependencies/shell/ui.js';

import {
    Config,
    Util,
} from './dependencies/shell/misc.js';

import {
    AppGroups,
    AppIcons,
    Docking,
    Theming,
    Utils,
} from './imports.js';

import {Extension} from './dependencies/shell/extensions/extension.js';

// Use __ () and N__() for the extension gettext domain, and reuse
// the shell domain with the default _() and N_()
const {gettext: __} = Extension;

// module "Dash" did not export DASH_ANIMATION_TIME in old versions
// so we just define it like it is defined in Dash;
// taken from https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/dash.js
const DASH_ANIMATION_TIME = Dash.DASH_ANIMATION_TIME ?? 200;
const DASH_VISIBILITY_TIMEOUT = 3;

const Labels = Object.freeze({
    SHOW_MOUNTS: Symbol('show-mounts'),
    FIRST_LAST_CHILD_WORKAROUND: Symbol('first-last-child-workaround'),
});

/**
 * Extend DashItemContainer
 *
 * - set label position based on dash orientation
 *
 */
const DockDashItemContainer = GObject.registerClass(
class DockDashItemContainer extends Dash.DashItemContainer {
    _init(position) {
        super._init();

        if (position === St.Side.TOP || position === St.Side.BOTTOM)
            this.xExpand = false;
        else
            this.yExpand = false;

        this.label?.add_style_class_name(Theming.PositionStyleClass[position]);
        if (Docking.DockManager.settings.customThemeShrink)
            this.label?.add_style_class_name('shrink');
    }

    showLabel() {
        return AppIcons.itemShowLabel.call(this);
    }

    // we override the method show taken from:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/dash.js
    // in order to apply a little modification at the end of the animation
    // which makes sure that the icon background is not blurry
    show(animate) {
        if (this.child == null)
            return;

        this.ease({
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: animate ? DASH_ANIMATION_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // when the animation is ended, we simulate
                // a hover to gain back focus and unblur the
                // background
                this.set_hover(true);
            },
        });
    }
});

const DockDashIconsVerticalLayout = GObject.registerClass(
    class DockDashIconsVerticalLayout extends Clutter.BoxLayout {
        _init() {
            super._init({
                orientation: Clutter.Orientation.VERTICAL,
            });
        }

        vfunc_get_preferred_height(container, forWidth) {
            const [natHeight] = super.vfunc_get_preferred_height(container, forWidth);
            return [natHeight, 0];
        }
    });

/**
 * Same as the upstream DragPlaceholderItem, that is not exported.
 */
const DockDragPlaceholderItem = GObject.registerClass(
class DockDragPlaceholderItem extends Dash.DashItemContainer {
    _init() {
        super._init();
        this.setChild(new St.Bin({style_class: 'placeholder'}));
    }
});

/**
 * Header of an application group: shows the group name and toggles the
 * group collapsed state when clicked.
 *
 * Application groups (this class, _handleGroupsDragOver(), _acceptGroupsDrop()
 * and the group layout methods of DockDash) are derived from Multi-Column
 * Dock, Copyright (c) 2025 Smart Coding & AI with Aliiman, under the MIT
 * license: see LICENSE-Multi-Column-Dock.
 *
 * It's a dash item, so that it lives in the dash box together with the app
 * icons, but it has no app delegate so it's ignored by the icons logic.
 */
const DockGroupHeader = GObject.registerClass(
class DockGroupHeader extends DockDashItemContainer {
    _init(position, groupId) {
        super._init(position);

        this.groupId = groupId;
        this._position = position;
        this._isHorizontal = position === St.Side.TOP || position === St.Side.BOTTOM;
        this.add_style_class_name('dash-group-header-container');

        if (this._isHorizontal)
            this.y_align = Clutter.ActorAlign.FILL;
        else
            this.x_align = Clutter.ActorAlign.FILL;

        this._arrow = new St.Icon({
            style_class: 'dash-group-header-arrow',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: this._isHorizontal,
            y_expand: this._isHorizontal,
        });

        this._nameLabel = new St.Label({
            style_class: 'dash-group-header-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: !this._isHorizontal,
        });
        this._nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const box = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
        });
        if (box.orientation !== undefined) {
            box.orientation = this._isHorizontal
                ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;
        } else {
            box.vertical = this._isHorizontal;
        }
        box.add_child(this._arrow);
        box.add_child(this._nameLabel);

        this.setChild(new St.Button({
            style_class: 'dash-group-header',
            child: box,
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
        }));
    }

    // The group name must never make the dock thicker: it's ellipsized to fit
    // the space that the app icons need.
    vfunc_get_preferred_width(forHeight) {
        const [minWidth, natWidth] = super.vfunc_get_preferred_width(forHeight);
        if (this._isHorizontal || !this._nameLabel.visible)
            return [minWidth, natWidth];

        const [, labelWidth] = this._nameLabel.get_preferred_width(-1);
        return [0, Math.max(0, natWidth - labelWidth * this.scale_x)];
    }

    update(group, nApps, headerSize) {
        const collapsed = !!group.collapsed;
        this.collapsed = collapsed;

        const name = group.name || __('Unnamed Group');
        const fullName = collapsed ? `${name} (${nApps})` : name;
        this._nameLabel.text = fullName;
        this.setLabelText(fullName);

        let iconName;
        if (!collapsed)
            iconName = this._isHorizontal ? 'pan-end-symbolic' : 'pan-down-symbolic';
        else if (this._position === St.Side.BOTTOM)
            iconName = 'pan-up-symbolic';
        else if (this._position === St.Side.TOP)
            iconName = 'pan-down-symbolic';
        else if (this._position === St.Side.RIGHT)
            iconName = 'pan-start-symbolic';
        else
            iconName = 'pan-end-symbolic';
        this._arrow.icon_name = iconName;

        this.child.set_style(this._isHorizontal
            ? `min-width: ${headerSize}px;` : `min-height: ${headerSize}px;`);
    }
});


const baseIconSizes = [16, 22, 24, 32, 48, 64, 96, 128];

/**
 * @param {object} source a drag source
 * @returns {Shell.App} the dragged app, if any
 */
function getAppFromSource(source) {
    if (Dash.Dash.getAppFromSource)
        return Dash.Dash.getAppFromSource(source);

    return source instanceof AppDisplay.AppIcon ? source.app : null;
}

/**
 * This class is a fork of the upstream dash class (ui.dash.js)
 *
 * Summary of changes:
 * - disconnect global signals adding a destroy method;
 * - play animations even when not in overview mode
 * - set a maximum icon size
 * - show running and/or favorite applications
 * - hide showApps label when the custom menu is shown.
 * - add scrollview
 *   ensure actor is visible on keyfocus inseid the scrollview
 * - add 128px icon size, might be useful for hidpi display
 * - sync minimization application target position.
 * - keep running apps ordered.
 */
export const DockDash = GObject.registerClass({
    Properties: {
        'requires-visibility': GObject.ParamSpec.boolean(
            'requires-visibility', 'requires-visibility', 'requires-visibility',
            GObject.ParamFlags.READWRITE,
            false),
        'max-width': GObject.ParamSpec.int(
            'max-width', 'max-width', 'max-width',
            GObject.ParamFlags.READWRITE,
            -1, GLib.MAXINT32, -1),
        'max-height': GObject.ParamSpec.int(
            'max-height', 'max-height', 'max-height',
            GObject.ParamFlags.READWRITE,
            -1, GLib.MAXINT32, -1),
    },
    Signals: {
        'menu-opened': {},
        'menu-closed': {},
        'icon-size-changed': {},
    },
}, class DockDash extends St.Widget {
    _init(monitorIndex) {
        // Initialize icon variables and size
        super._init({
            name: 'dash',
            offscreen_redirect: Clutter.OffscreenRedirect.ALWAYS,
            layout_manager: new Clutter.BinLayout(),
        });

        this._maxWidth = -1;
        this._maxHeight = -1;
        this.iconSize = Docking.DockManager.settings.dashMaxIconSize;
        this._availableIconSizes = baseIconSizes;
        this._shownInitially = false;
        this._initializeIconSize(this.iconSize);
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);

        this._separator = null;

        // Group headers, by group id, and the groups as currently displayed
        // (null when groups are disabled)
        this._groupHeaders = new Map();
        this._groupsLayout = null;
        this._groupDropTarget = null;
        this._groupsStyled = false;

        this._monitorIndex = monitorIndex;
        this._position = Utils.getPosition();
        this._isHorizontal = (this._position === St.Side.TOP) ||
                               (this._position === St.Side.BOTTOM);

        this._dragPlaceholder = null;
        this._dragPlaceholderPos = -1;
        this._animatingPlaceholdersCount = 0;
        this._showLabelTimeoutId = 0;
        this._resetHoverTimeoutId = 0;
        this._labelShowing = false;

        this._dashContainer = new St.BoxLayout({
            name: 'dashtodockDashContainer',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: this._isHorizontal,
            x_expand: !this._isHorizontal,
        });

        this._scrollView = new St.ScrollView({
            name: 'dashtodockDashScrollview',
            hscrollbar_policy: this._isHorizontal ? St.PolicyType.EXTERNAL : St.PolicyType.NEVER,
            vscrollbar_policy: this._isHorizontal ?  St.PolicyType.NEVER : St.PolicyType.EXTERNAL,
            x_expand: this._isHorizontal,
            y_expand: !this._isHorizontal,
            enable_mouse_scrolling: false,
        });

        this._scrollView.connect('scroll-event', this._onScrollEvent.bind(this));

        this._boxContainer = new St.BoxLayout({
            name: 'dashtodockBoxContainer',
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._boxContainer.add_style_class_name(Theming.PositionStyleClass[this._position]);

        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        this._box = new St.BoxLayout({
            clip_to_allocation: false,
            ...!this._isHorizontal ? {layout_manager: new DockDashIconsVerticalLayout()} : {},
            x_align: rtl ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
            y_align: this._isHorizontal ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            y_expand: !this._isHorizontal,
            x_expand: this._isHorizontal,
        });

        if (this._dashContainer.orientation !== undefined) {
            this._dashContainer.orientation =
                this._boxContainer.orientation =
                this._box.orientation = this._isHorizontal
                    ? Clutter.Orientation.HORIZONTAL
                    : Clutter.Orientation.VERTICAL;
        } else {
            this._dashContainer.vertical =
                this._boxContainer.vertical =
                this._box.vertical = !this._isHorizontal;
        }

        this._box._delegate = this;
        this._boxContainer.add_child(this._box);
        Utils.addActor(this._scrollView, this._boxContainer);
        this._dashContainer.add_child(this._scrollView);

        this._showAppsIcon = new AppIcons.DockShowAppsIcon(this._position);
        this._showAppsIcon.show(false);
        this._showAppsIcon.icon.setIconSize(this.iconSize);
        this._showAppsIcon.x_expand = false;
        this._showAppsIcon.y_expand = false;
        this.showAppsButton.connect('notify::hover', a => {
            if (this._showAppsIcon.get_parent() === this._boxContainer)
                this._ensureItemVisibility(a);
        });
        if (!this._isHorizontal)
            this._showAppsIcon.y_align = Clutter.ActorAlign.START;
        this._hookUpLabel(this._showAppsIcon);
        this._showAppsIcon.connect('menu-state-changed', (_icon, opened) => {
            this._itemMenuStateChanged(this._showAppsIcon, opened);
        });
        this.updateShowAppsButton();

        this._background = new St.Widget({
            style_class: 'dash-background',
            y_expand: this._isHorizontal,
            x_expand: !this._isHorizontal,
        });

        const sizerBox = new Clutter.Actor();
        sizerBox.add_constraint(new Clutter.BindConstraint({
            source: this._isHorizontal ? this._showAppsIcon.icon : this._dashContainer,
            coordinate: Clutter.BindCoordinate.HEIGHT,
        }));
        sizerBox.add_constraint(new Clutter.BindConstraint({
            source: this._isHorizontal ? this._dashContainer : this._showAppsIcon.icon,
            coordinate: Clutter.BindCoordinate.WIDTH,
        }));
        this._background.add_child(sizerBox);

        // Group backgrounds are aligned to the dash background
        this._background.connect('style-changed', () => {
            if (this._groupsLayout)
                this._queueRedisplay();
        });

        this.add_child(this._background);
        this.add_child(this._dashContainer);

        this._workId = Main.initializeDeferredWork(this._box, () => this._redisplay());

        this._shellSettings = new Gio.Settings({
            schema_id: 'org.gnome.shell',
        });

        this._appSystem = Shell.AppSystem.get_default();

        this.iconAnimator = new Docking.IconAnimator(this);

        this._signalsHandler.add([
            this._appSystem,
            'installed-changed',
            () => {
                AppFavorites.getAppFavorites().reload();
                this._queueRedisplay();
            },
        ], [
            AppFavorites.getAppFavorites(),
            'changed',
            this._queueRedisplay.bind(this),
        ], [
            this._appSystem,
            'app-state-changed',
            this._queueRedisplay.bind(this),
        ], [
            Main.overview,
            'item-drag-begin',
            this._onItemDragBegin.bind(this),
        ], [
            Main.overview,
            'item-drag-end',
            this._onItemDragEnd.bind(this),
        ], [
            Main.overview,
            'item-drag-cancelled',
            this._onItemDragCancelled.bind(this),
        ], [
            Main.overview,
            'window-drag-begin',
            this._onWindowDragBegin.bind(this),
        ], [
            Main.overview,
            'window-drag-cancelled',
            this._onWindowDragEnd.bind(this),
        ], [
            Main.overview,
            'window-drag-end',
            this._onWindowDragEnd.bind(this),
        ]);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    vfunc_get_preferred_height(forWidth) {
        const [minHeight, natHeight] = super.vfunc_get_preferred_height.call(this, forWidth);
        if (!this._isHorizontal && this._maxHeight !== -1 && natHeight > this._maxHeight)
            return [minHeight, this._maxHeight];
        else
            return [minHeight, natHeight];
    }

    vfunc_get_preferred_width(forHeight) {
        const [minWidth, natWidth] = super.vfunc_get_preferred_width.call(this, forHeight);
        if (this._isHorizontal && this._maxWidth !== -1 && natWidth > this._maxWidth)
            return [minWidth, this._maxWidth];
        else
            return [minWidth, natWidth];
    }

    get _container() {
        return this._dashContainer;
    }

    _onDestroy() {
        this.iconAnimator.destroy();

        this._groupHeaders.forEach(header => header.destroy());
        this._groupHeaders.clear();

        if (this._requiresVisibilityTimeout) {
            GLib.source_remove(this._requiresVisibilityTimeout);
            delete this._requiresVisibilityTimeout;
        }

        if (this._ensureActorVisibilityTimeoutId) {
            GLib.source_remove(this._ensureActorVisibilityTimeoutId);
            delete this._ensureActorVisibilityTimeoutId;
        }

        if (this._showLabelTimeoutId) {
            GLib.source_remove(this._showLabelTimeoutId);
            this._showLabelTimeoutId = 0;
        }
    }


    _onItemDragBegin(...args) {
        return Dash.Dash.prototype._onItemDragBegin.call(this, ...args);
    }

    _onItemDragCancelled(...args) {
        return Dash.Dash.prototype._onItemDragCancelled.call(this, ...args);
    }

    _onItemDragEnd(...args) {
        return Dash.Dash.prototype._onItemDragEnd.call(this, ...args);
    }

    _endItemDrag(...args) {
        return Dash.Dash.prototype._endItemDrag.call(this, ...args);
    }

    _onItemDragMotion(...args) {
        return Dash.Dash.prototype._onItemDragMotion.call(this, ...args);
    }

    _appIdListToHash(...args) {
        return Dash.Dash.prototype._appIdListToHash.call(this, ...args);
    }

    _queueRedisplay(...args) {
        return Dash.Dash.prototype._queueRedisplay.call(this, ...args);
    }

    _hookUpLabel(...args) {
        return Dash.Dash.prototype._hookUpLabel.call(this, ...args);
    }

    _syncLabel(...args) {
        return Dash.Dash.prototype._syncLabel.call(this, ...args);
    }

    _clearEmptyDropTarget(...args) {
        return Dash.Dash.prototype._clearEmptyDropTarget.call(this, ...args);
    }

    handleDragOver(source, actor, x, y, time) {
        let ret;
        if (this._groupsLayout) {
            ret = this._handleGroupsDragOver(source, x, y);

            if (ret === DND.DragMotionResult.CONTINUE)
                return ret;
        } else if (this._isHorizontal) {
            ret = Dash.Dash.prototype.handleDragOver.call(this, source, actor, x, y, time);

            if (ret === DND.DragMotionResult.CONTINUE)
                return ret;
        } else {
            const propertyInjections = new Utils.PropertyInjectionsHandler();
            propertyInjections.add(this._box, 'width', {
                get: () => this._box.get_children().reduce((a, c) => a + c.height, 0),
            });

            if (this._dragPlaceholder) {
                propertyInjections.add(this._dragPlaceholder, 'width', {
                    get: () => this._dragPlaceholder.height,
                });
            }

            ret = Dash.Dash.prototype.handleDragOver.call(this, source, actor, y, x, time);
            propertyInjections.destroy();

            if (ret === DND.DragMotionResult.CONTINUE)
                return ret;

            if (this._dragPlaceholder) {
                this._dragPlaceholder.child.set_width(this.iconSize / 2);
                this._dragPlaceholder.child.set_height(this.iconSize);

                let pos = this._dragPlaceholderPos;
                if (this._isHorizontal &&
                    Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
                    pos = this._box.get_children() - 1 - pos;

                if (pos !== this._dragPlaceholderPos) {
                    this._dragPlaceholderPos = pos;
                    this._box.set_child_at_index(this._dragPlaceholder,
                        this._dragPlaceholderPos);
                }
            }
        }

        if (this._dragPlaceholder) {
            // Ensure the next and previous icon are visible when moving the
            // placeholder (we're assuming there's room for both of them)
            const children = this._box.get_children();
            if (this._dragPlaceholderPos > 0) {
                ensureActorVisibleInScrollView(this._scrollView,
                    children[this._dragPlaceholderPos - 1]);
            }

            if (this._dragPlaceholderPos >= -1 &&
                this._dragPlaceholderPos < children.length - 1) {
                ensureActorVisibleInScrollView(this._scrollView,
                    children[this._dragPlaceholderPos + 1]);
            }
        }

        return ret;
    }

    acceptDrop(...args) {
        if (this._groupsLayout)
            return this._acceptGroupsDrop(...args);

        return Dash.Dash.prototype.acceptDrop.call(this, ...args);
    }

    _clearDragPlaceholder(...args) {
        this._groupDropTarget = null;
        return Dash.Dash.prototype._clearDragPlaceholder.call(this, ...args);
    }

    /**
     * Drag and drop handling when the apps are organized in groups: the drop
     * position decides both the group the app is moved to and its position in
     * the group (or in the favorites, for the ungrouped apps).
     *
     * @param {object} source the dragged object
     * @param {number} x the pointer position, relative to this._box
     * @param {number} y the pointer position, relative to this._box
     */
    _handleGroupsDragOver(source, x, y) {
        const app = getAppFromSource(source);

        // Don't allow favoriting of transient apps, nor grouping of locations
        if (!app || app.is_window_backed() || app.location)
            return DND.DragMotionResult.NO_DROP;

        if (!global.settings.is_writable('favorite-apps'))
            return DND.DragMotionResult.NO_DROP;

        const appOf = actor => actor?.child?._delegate?.app ?? null;
        const isHeader = actor => actor instanceof DockGroupHeader;
        const children = this._box.get_children().filter(c =>
            c !== this._dragPlaceholder && !c.animatingOut && c.visible);

        // Locations are always at the end, outside of the groups.
        let lastIndex = children.findIndex(c => appOf(c)?.location);
        if (lastIndex === -1)
            lastIndex = children.length;

        const rtl = this._isHorizontal &&
            this.text_direction === Clutter.TextDirection.RTL;
        const coord = this._isHorizontal ? x : y;
        let index = children.findIndex(c => {
            const center = this._isHorizontal
                ? (c.allocation.x1 + c.allocation.x2) / 2
                : (c.allocation.y1 + c.allocation.y2) / 2;
            return rtl ? coord > center : coord < center;
        });
        if (index === -1 || index > lastIndex)
            index = lastIndex;

        // Nothing can go before the first group header.
        if (index === 0 && isHeader(children[0]))
            index = 1;

        let headerIndex = index - 1;
        while (headerIndex >= 0 && !isHeader(children[headerIndex]))
            headerIndex--;

        const groupId = headerIndex >= 0
            ? children[headerIndex].groupId : AppGroups.OTHER_GROUP_ID;
        const prevApp = appOf(children[index - 1]);
        const nextApp = index < lastIndex && !isHeader(children[index])
            ? appOf(children[index]) : null;
        const groupPos = children.slice(headerIndex + 1, index).filter(c => {
            const childApp = appOf(c);
            return childApp && childApp !== app;
        }).length;

        const next = children[index] ?? null;
        if (next !== this._groupDropTarget?.next &&
            this._animatingPlaceholdersCount === 0) {
            // Don't allow positioning before or after self
            if (prevApp === app || appOf(next) === app) {
                this._clearDragPlaceholder();
                return DND.DragMotionResult.CONTINUE;
            }

            // If the placeholder already exists, we just move
            // it, but if we are adding it, expand its size in
            // an animation
            const fadeIn = !this._dragPlaceholder;
            this._dragPlaceholder?.destroy();

            this._dragPlaceholder = new DockDragPlaceholderItem();
            this._dragPlaceholder.child.set_width(
                this._isHorizontal ? this.iconSize : this.iconSize / 2);
            this._dragPlaceholder.child.set_height(
                this._isHorizontal ? this.iconSize / 2 : this.iconSize);

            if (next)
                this._box.insert_child_below(this._dragPlaceholder, next);
            else
                this._box.add_child(this._dragPlaceholder);

            this._dragPlaceholder.show(fadeIn);
            this._dragPlaceholderPos =
                this._box.get_children().indexOf(this._dragPlaceholder);
            this._groupDropTarget = {next, groupId, groupPos, prevApp, nextApp};
        }

        if (!this._dragPlaceholder)
            return DND.DragMotionResult.NO_DROP;

        return DND.DragMotionResult.MOVE_DROP;
    }

    _acceptGroupsDrop(source) {
        const app = getAppFromSource(source);

        if (!app || app.is_window_backed() || app.location)
            return false;

        if (!global.settings.is_writable('favorite-apps'))
            return false;

        // No drag placeholder means we are dragging the app to its
        // original position
        if (!this._dragPlaceholder || !this._groupDropTarget)
            return true;

        const {groupId, groupPos, prevApp, nextApp} = this._groupDropTarget;
        const id = app.get_id();

        Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            const {settings} = Docking.DockManager;
            const groups = AppGroups.parseGroups(settings.appGroups);
            AppGroups.moveAppToGroup(groups, id, groupId, groupPos);
            settings.set_string('app-groups', AppGroups.serializeGroups(groups));

            const appFavorites = AppFavorites.getAppFavorites();
            const srcIsFavorite = appFavorites.isFavorite(id);

            if (groupId !== AppGroups.OTHER_GROUP_ID) {
                // Grouped apps are ordered by the group, just ensure it's pinned
                if (!srcIsFavorite)
                    appFavorites.addFavorite(id);
                return GLib.SOURCE_REMOVE;
            }

            // Ungrouped apps are shown in favorites order, so move it there.
            const favoriteIds = appFavorites.getFavorites().map(a => a.get_id())
                .filter(favId => favId !== id);
            let favPos = -1;
            if (nextApp && favoriteIds.includes(nextApp.get_id()))
                favPos = favoriteIds.indexOf(nextApp.get_id());
            else if (prevApp && favoriteIds.includes(prevApp.get_id()))
                favPos = favoriteIds.indexOf(prevApp.get_id()) + 1;

            if (srcIsFavorite)
                appFavorites.moveFavoriteToPos(id, favPos);
            else
                appFavorites.addFavoriteAtPos(id, favPos);

            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    _onWindowDragBegin(...args) {
        return Dash.Dash.prototype._onWindowDragBegin.call(this, ...args);
    }

    _onWindowDragEnd(...args) {
        return Dash.Dash.prototype._onWindowDragEnd.call(this, ...args);
    }

    _onScrollEvent(actor, event) {
        // If scroll is not used because the icon is resized, let the scroll event propagate.
        if (!Docking.DockManager.settings.iconSizeFixed)
            return Clutter.EVENT_PROPAGATE;

        // reset timeout to avid conflicts with the mousehover event
        this._ensureItemVisibility(null);

        // Skip to avoid double events mouse
        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_STOP;


        let adjustment, delta = 0;

        if (this._isHorizontal) {
            adjustment = this._scrollView.get_hadjustment
                ? this._scrollView.get_hadjustment()
                : this._scrollView.get_hscroll_bar().get_adjustment();
        } else {
            adjustment = this._scrollView.get_vadjustment
                ? this._scrollView.get_vadjustment()
                : this._scrollView.get_vscroll_bar().get_adjustment();
        }

        const increment = adjustment.step_increment;
        const [dx, dy] = event.get_scroll_delta();

        if (this._isHorizontal)
            delta = (Math.abs(dx) > Math.abs(dy) ? dx : dy) * increment;
        else
            delta = dy * increment;

        const value = adjustment.get_value();

        // TODO: Remove this if possible.
        if (Number.isNaN(value))
            adjustment.set_value(delta);
        else
            adjustment.set_value(value + delta);

        return Clutter.EVENT_STOP;
    }

    _ensureItemVisibility(actor) {
        if (actor?.hover) {
            const destroyId =
                actor.connect('destroy', () => this._ensureItemVisibility(null));
            this._ensureActorVisibilityTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 100, () => {
                    actor.disconnect(destroyId);
                    ensureActorVisibleInScrollView(this._scrollView, actor);
                    this._ensureActorVisibilityTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                });
        } else if (this._ensureActorVisibilityTimeoutId) {
            GLib.source_remove(this._ensureActorVisibilityTimeoutId);
            this._ensureActorVisibilityTimeoutId = 0;
        }
    }

    _createAppItem(app) {
        const appIcon = new AppIcons.makeAppIcon(app, this._monitorIndex, this.iconAnimator);

        if (appIcon._draggable) {
            appIcon._draggable.connect('drag-begin', () => {
                appIcon.opacity = 50;
            });
            appIcon._draggable.connect('drag-end', () => {
                appIcon.opacity = 255;
            });
        }

        appIcon.connectObject('menu-state-changed', (_, opened) => {
            this._itemMenuStateChanged(item, opened);
        }, this);

        const item = new DockDashItemContainer(this._position);
        item.setChild(appIcon);

        appIcon.connectObject('notify::hover', a => this._ensureItemVisibility(a), this);
        appIcon.connectObject('clicked', actor => {
            ensureActorVisibleInScrollView(this._scrollView, actor);
        }, this);

        appIcon.connectObject('key-focus-in', actor => {
            const [xShift, yShift] = ensureActorVisibleInScrollView(this._scrollView, actor);

            // This signal is triggered also by mouse click. The popup menu is opened at the original
            // coordinates. Thus correct for the shift which is going to be applied to the scrollview.
            if (appIcon._menu) {
                appIcon._menu._boxPointer.xOffset = -xShift;
                appIcon._menu._boxPointer.yOffset = -yShift;
            }
        }, this);

        appIcon.connectObject('notify::focused', () => {
            const {settings} = Docking.DockManager;
            if (appIcon.focused && settings.scrollToFocusedApplication)
                ensureActorVisibleInScrollView(this._scrollView, item);
        }, this);

        appIcon.connectObject('notify::urgent', () => {
            if (appIcon.urgent) {
                ensureActorVisibleInScrollView(this._scrollView, item);
                if (Docking.DockManager.settings.showDockUrgentNotify)
                    this._requireVisibility();
            }
        }, this);

        // Override default AppIcon labelActor, now the
        // accessibleName is set at DashItemContainer.setLabelText
        appIcon.labelActor = null;
        item.setLabelText(app.get_name());

        appIcon.icon.setIconSize(this.iconSize);
        this._hookUpLabel(item, appIcon);

        item.connectObject('notify::position', () => appIcon.updateIconGeometry(), appIcon);
        item.connectObject('notify::size', () => appIcon.updateIconGeometry(), appIcon);

        return item;
    }

    _requireVisibility() {
        this.requiresVisibility = true;

        if (this._requiresVisibilityTimeout)
            GLib.source_remove(this._requiresVisibilityTimeout);

        this._requiresVisibilityTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            DASH_VISIBILITY_TIMEOUT, () => {
                this._requiresVisibilityTimeout = 0;
                this.requiresVisibility = false;
            });
    }

    /**
     * Return an array with the "proper" appIcons currently in the dash
     */
    getAppIcons() {
        // Only consider children which are "proper"
        // icons (i.e. ignoring drag placeholders) and which are not
        // animating out (which means they will be destroyed at the end of
        // the animation)
        const iconChildren = this._box.get_children().filter(actor => {
            return actor.child &&
                   !!actor.child.icon &&
                   !actor.animatingOut;
        });

        const appIcons = iconChildren.map(actor => {
            return actor.child;
        });

        return appIcons;
    }

    _itemMenuStateChanged(item, opened) {
        Dash.Dash.prototype._itemMenuStateChanged.call(this, item, opened);

        if (opened) {
            this.emit('menu-opened');
        } else {
            // I want to listen from outside when a menu is closed. I used to
            // add a custom signal to the appIcon, since gnome 3.8 the signal
            // calling this callback was added upstream.
            this.emit('menu-closed');
        }
    }

    _adjustIconSize() {
        // For the icon size, we only consider children which are "proper"
        // icons (i.e. ignoring drag placeholders) and which are not
        // animating out (which means they will be destroyed at the end of
        // the animation)
        const iconChildren = this._box.get_children().filter(actor => {
            return actor.child &&
                   actor.child._delegate &&
                   actor.child._delegate.icon &&
                   !actor.animatingOut;
        });

        iconChildren.push(this._showAppsIcon);

        if (this._maxWidth === -1 && this._maxHeight === -1)
            return;

        // Check if the container is present in the stage. This avoids critical
        // errors when unlocking the screen
        if (!this._container.get_stage())
            return;

        const themeNode = this._dashContainer.get_theme_node();
        const maxAllocation = new Clutter.ActorBox({
            x1: 0,
            y1: 0,
            x2: this._isHorizontal ? this._maxWidth : 42 /* whatever */,
            y2: this._isHorizontal ? 42 : this._maxHeight,
        });
        const maxContent = themeNode.get_content_box(maxAllocation);
        let availSpace;
        if (this._isHorizontal)
            availSpace = maxContent.get_width();
        else
            availSpace = maxContent.get_height();

        const spacing = themeNode.get_length('spacing');

        const [{child: firstButton}] = iconChildren;
        const {child: firstIcon} = firstButton?.icon ?? {child: null};

        // if no icons there's nothing to adjust
        if (!firstIcon)
            return;

        // Enforce valid spacings during the size request
        firstIcon.ensure_style();
        const [, , iconWidth, iconHeight] = firstIcon.get_preferred_size();
        const [, , buttonWidth, buttonHeight] = firstButton.get_preferred_size();

        if (this._isHorizontal) {
            // Subtract icon padding and box spacing from the available width
            availSpace -= iconChildren.length * (buttonWidth - iconWidth) +
                           (iconChildren.length - 1) * spacing;

            if (this._separator) {
                const [, , separatorWidth] = this._separator.get_preferred_size();
                availSpace -= separatorWidth + spacing;
            }
        } else {
            // Subtract icon padding and box spacing from the available height
            availSpace -= iconChildren.length * (buttonHeight - iconHeight) +
                           (iconChildren.length - 1) * spacing;

            if (this._separator) {
                const [, , , separatorHeight] = this._separator.get_preferred_size();
                availSpace -= separatorHeight + spacing;
            }
        }

        if (this._groupsLayout) {
            const {scaleFactor: themeScale} = St.ThemeContext.get_for_stage(global.stage);
            const groupSpacing = Docking.DockManager.settings.groupSpacing * themeScale;
            this._groupHeaders.forEach(header => {
                const [, , headerWidth, headerHeight] = header.get_preferred_size();
                availSpace -= (this._isHorizontal ? headerWidth : headerHeight) +
                    spacing + groupSpacing;
            });
        }

        const maxIconSize = availSpace / iconChildren.length;
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const iconSizes = this._availableIconSizes.map(s => s * scaleFactor);

        let [newIconSize] = this._availableIconSizes;
        for (let i = 0; i < iconSizes.length; i++) {
            if (iconSizes[i] <= maxIconSize)
                newIconSize = this._availableIconSizes[i];
        }

        if (newIconSize === this.iconSize)
            return;

        const oldIconSize = this.iconSize;
        this.iconSize = newIconSize;
        this.emit('icon-size-changed');

        const scale = oldIconSize / newIconSize;
        for (let i = 0; i < iconChildren.length; i++) {
            const {icon} = iconChildren[i].child._delegate;

            // Set the new size immediately, to keep the icons' sizes
            // in sync with this.iconSize
            icon.setIconSize(this.iconSize);

            // Don't animate the icon size change when the overview
            // is transitioning, not visible or when initially filling
            // the dash
            if (!Main.overview.visible || Main.overview.animationInProgress ||
                !this._shownInitially)
                continue;

            const [targetWidth, targetHeight] = icon.icon.get_size();

            // Scale the icon's texture to the previous size and
            // tween to the new size
            icon.icon.set_size(icon.icon.width * scale,
                icon.icon.height * scale);

            icon.icon.ease({
                width: targetWidth,
                height: targetHeight,
                duration: DASH_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        if (this._separator) {
            const animateProperties = this._isHorizontal
                ? {height: this.iconSize} : {width: this.iconSize};

            this._separator.ease({
                ...animateProperties,
                duration: DASH_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    vfunc_map() {
        super.vfunc_map();
        this._queueRedisplay();
    }

    _redisplay() {
        if (!this.mapped)
            return;

        const favorites = AppFavorites.getAppFavorites().getFavoriteMap();

        let running = this._appSystem.get_running();
        const dockManager = Docking.DockManager.getDefault();
        const {settings} = dockManager;

        this._scrollView.set({
            xAlign: Clutter.ActorAlign.FILL,
            yAlign: Clutter.ActorAlign.FILL,
        });
        if (dockManager.settings.dockExtended) {
            if (!this._isHorizontal) {
                this._scrollView.yAlign = dockManager.settings.alwaysCenterIcons
                    ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
            } else {
                this._scrollView.xAlign = dockManager.settings.alwaysCenterIcons
                    ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
            }
        }

        if (settings.isolateWorkspaces ||
            settings.isolateMonitors) {
            // When using isolation, we filter out apps that have no windows in
            // the current workspace
            const monitorIndex = this._monitorIndex;
            running = running.filter(app =>
                AppIcons.getInterestingWindows(app.get_windows(), monitorIndex).length);
        }

        const children = this._box.get_children().filter(actor => {
            return actor.child &&
                   actor.child._delegate &&
                   actor.child._delegate.app;
        });
        // Apps currently in the dash
        let oldApps = children.map(actor => actor.child._delegate.app);
        // Apps supposed to be in the dash
        const newApps = [];

        const {showFavorites} = settings;
        if (showFavorites)
            newApps.push(...Object.values(favorites));

        if (settings.showRunning) {
            // We reorder the running apps so that they don't change position on the
            // dash with every redisplay() call

            // First: add the apps from the oldApps list that are still running
            oldApps.forEach(oldApp => {
                const index = running.indexOf(oldApp);
                if (index > -1) {
                    const [app] = running.splice(index, 1);
                    if (!showFavorites || !(app.get_id() in favorites))
                        newApps.push(app);
                }
            });

            // Second: add the new apps
            running.forEach(app => {
                if (!showFavorites || !(app.get_id() in favorites))
                    newApps.push(app);
            });
        }

        this._signalsHandler.removeWithLabel(Labels.SHOW_MOUNTS);
        if (dockManager.removables) {
            this._signalsHandler.addWithLabel(Labels.SHOW_MOUNTS,
                dockManager.removables, 'changed', this._queueRedisplay.bind(this));
            dockManager.removables.getApps().forEach(removable => {
                if (!newApps.includes(removable))
                    newApps.push(removable);
            });
        } else {
            oldApps = oldApps.filter(app => !app.location || app.isTrash);
        }

        if (dockManager.trash) {
            const trashApp = dockManager.trash.getApp();
            if (!newApps.includes(trashApp))
                newApps.push(trashApp);
        } else {
            oldApps = oldApps.filter(app => !app.isTrash);
        }

        const groupsLayout = settings.enableGroups
            ? this._arrangeAppsInGroups(newApps) : null;
        if (groupsLayout)
            newApps.splice(0, newApps.length, ...groupsLayout.apps);

        // Temporary remove the separator so that we don't compute to position icons
        const oldSeparatorPos = this._box.get_children().indexOf(this._separator);
        if (this._separator)
            this._box.remove_child(this._separator);

        // Same for the group headers, they're placed back once icons are in place
        this._groupHeaders.forEach(header => header.get_parent()?.remove_child(header));

        // Figure out the actual changes to the list of items; we iterate
        // over both the list of items currently in the dash and the list
        // of items expected there, and collect additions and removals.
        // Moves are both an addition and a removal, where the order of
        // the operations depends on whether we encounter the position
        // where the item has been added first or the one from where it
        // was removed.
        // There is an assumption that only one item is moved at a given
        // time; when moving several items at once, everything will still
        // end up at the right position, but there might be additional
        // additions/removals (e.g. it might remove all the launchers
        // and add them back in the new order even if a smaller set of
        // additions and removals is possible).
        // If above assumptions turns out to be a problem, we might need
        // to use a more sophisticated algorithm, e.g. Longest Common
        // Subsequence as used by diff.

        const addedItems = [];
        const removedActors = [];

        let newIndex = 0;
        let oldIndex = 0;
        while (newIndex < newApps.length || oldIndex < oldApps.length) {
            const oldApp = oldApps.length > oldIndex ? oldApps[oldIndex] : null;
            const newApp = newApps.length > newIndex ? newApps[newIndex] : null;

            // No change at oldIndex/newIndex
            if (oldApp === newApp) {
                oldIndex++;
                newIndex++;
                continue;
            }

            // App removed at oldIndex
            if (oldApp && !newApps.includes(oldApp)) {
                removedActors.push(children[oldIndex]);
                oldIndex++;
                continue;
            }

            // App added at newIndex
            if (newApp && !oldApps.includes(newApp)) {
                addedItems.push({
                    app: newApp,
                    item: this._createAppItem(newApp),
                    pos: newIndex,
                });
                newIndex++;
                continue;
            }

            // App moved
            const nextApp = newApps.length > newIndex + 1
                ? newApps[newIndex + 1] : null;
            const insertHere = nextApp && nextApp === oldApp;
            const alreadyRemoved = removedActors.reduce((result, actor) => {
                const removedApp = actor.child._delegate.app;
                return result || removedApp === newApp;
            }, false);

            if (insertHere || alreadyRemoved) {
                const newItem = this._createAppItem(newApp);
                addedItems.push({
                    app: newApp,
                    item: newItem,
                    pos: newIndex + removedActors.length,
                });
                newIndex++;
            } else {
                removedActors.push(children[oldIndex]);
                oldIndex++;
            }
        }

        for (let i = 0; i < addedItems.length; i++) {
            this._box.insert_child_at_index(addedItems[i].item,
                addedItems[i].pos);
        }

        for (let i = 0; i < removedActors.length; i++) {
            const item = removedActors[i];

            // Don't animate item removal when the overview is transitioning
            // or hidden
            if (!Main.overview.animationInProgress)
                item.animateOutAndDestroy();
            else
                item.destroy();
        }

        // Update separator
        const nFavorites = Object.keys(favorites).length;
        const nIcons = children.length + addedItems.length - removedActors.length;
        if (!groupsLayout && nFavorites > 0 && nFavorites < nIcons) {
            if (!this._separator) {
                this._separator = new St.Widget({
                    style_class: 'dash-separator',
                    x_align: this._isHorizontal
                        ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
                    y_align: this._isHorizontal
                        ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
                    width: this._isHorizontal ? -1 : this.iconSize,
                    height: this._isHorizontal ? this.iconSize : -1,
                    reactive: true,
                    track_hover: true,
                });
                this._separator.connect('notify::hover', a => this._ensureItemVisibility(a));
            }
            let pos = nFavorites + this._animatingPlaceholdersCount;
            if (this._dragPlaceholder)
                pos++;
            const removedFavorites = removedActors.filter(a =>
                children.indexOf(a) < oldSeparatorPos);
            pos += removedFavorites.length;
            this._box.insert_child_at_index(this._separator, pos);
        } else if (this._separator) {
            this._separator.destroy();
            this._separator = null;
        }

        this._updateGroupHeaders(groupsLayout);

        this._adjustIconSize();

        // Skip animations on first run when adding the initial set
        // of items, to avoid all items zooming in at once
        const animate = this._shownInitially &&
            !Main.layoutManager._startingUp;

        if (!this._shownInitially)
            this._shownInitially = true;

        addedItems.forEach(({item}) => item.show(animate));

        // This will update the size, and the corresponding number for each icon
        this._updateNumberOverlay();

        this.updateShowAppsButton();
    }

    /**
     * Sort the apps by group.
     *
     * @param {Shell.App[]} apps the apps to show in the dash
     * @returns {object} the displayed groups with their apps, and the apps
     * to show in the dash, apps of collapsed groups excluded
     */
    _arrangeAppsInGroups(apps) {
        const {settings} = Docking.DockManager;
        const groups = AppGroups.parseGroups(settings.appGroups);
        const locations = apps.filter(app => app.location);
        const appsById = new Map(apps.filter(app => !app.location).map(app =>
            [app.get_id(), app]));
        const assigned = new Set();

        const groupsApps = new Map(groups.filter(g => !AppGroups.isOtherGroup(g)).map(group => {
            const groupApps = group.apps.map(id => appsById.get(id)).filter(app => {
                if (!app || assigned.has(app))
                    return false;
                assigned.add(app);
                return true;
            });
            return [group, groupApps];
        }));

        // Ungrouped apps keep the default dash order
        const otherApps = settings.showUngrouped
            ? [...appsById.values()].filter(app => !assigned.has(app)) : [];

        const displayedGroups = groups.map(group => ({
            group,
            apps: AppGroups.isOtherGroup(group) ? otherApps : groupsApps.get(group),
        })).filter(({apps: groupApps}) => groupApps.length);

        return {
            groups: displayedGroups,
            apps: [
                ...displayedGroups.flatMap(({group, apps: groupApps}) =>
                    group.collapsed ? [] : groupApps),
                ...locations,
            ],
        };
    }

    _createGroupHeader(groupId) {
        const header = new DockGroupHeader(this._position, groupId);
        header.child.connect('clicked', () => this._toggleGroupCollapsed(groupId));
        header.child.connect('notify::hover', a => this._ensureItemVisibility(a));
        this._hookUpLabel(header);
        header.show(false);
        return header;
    }

    _toggleGroupCollapsed(groupId) {
        const {settings} = Docking.DockManager;
        const groups = AppGroups.parseGroups(settings.appGroups);
        const group = groups.find(g => g.id === groupId);
        if (!group)
            return;

        group.collapsed = !group.collapsed;
        settings.set_string('app-groups', AppGroups.serializeGroups(groups));
    }

    /**
     * Place the group headers before the apps of each group and paint the
     * group backgrounds, or clean them up if groups are disabled.
     *
     * @param {object} groupsLayout the layout from _arrangeAppsInGroups()
     */
    _updateGroupHeaders(groupsLayout) {
        const {settings} = Docking.DockManager;
        const displayedIds = new Set(groupsLayout?.groups.map(({group}) => group.id));

        this._groupHeaders.forEach((header, id) => {
            if (!displayedIds.has(id)) {
                header.destroy();
                this._groupHeaders.delete(id);
            }
        });

        this._groupsLayout = groupsLayout;

        const items = this._box.get_children().filter(actor =>
            actor.child?._delegate?.app && !actor.animatingOut);

        if (!groupsLayout) {
            if (this._groupsStyled) {
                this._box.get_children().filter(actor => actor.child?._delegate?.app)
                    .forEach(item => this._setGroupItemStyle(item, null));
            }
            this._groupsStyled = false;
            return;
        }

        const crossInsets = this._getGroupCrossInsets();
        const itemsByApp = new Map(items.map(item => [item.child._delegate.app, item]));
        // Items of just collapsed groups are still there while animating out
        const leavingItems = this._box.get_children().filter(actor =>
            actor.child?._delegate?.app && actor.animatingOut);
        const locationItems = items.filter(item => item.child._delegate.app.location);
        locationItems.forEach(item => this._setGroupItemStyle(item, null));

        // Go backwards, so that each header can be placed before the next one
        // when its group is collapsed.
        let nextActor = locationItems[0] ?? null;
        for (let i = groupsLayout.groups.length - 1; i >= 0; i--) {
            const {group, apps} = groupsLayout.groups[i];
            let header = this._groupHeaders.get(group.id);
            if (!header) {
                header = this._createGroupHeader(group.id);
                this._groupHeaders.set(group.id, header);
            }
            header.update(group, apps.length, settings.groupHeaderSize);

            const groupItems = group.collapsed ? []
                : apps.map(app => itemsByApp.get(app)).filter(item => item);
            const sibling = groupItems[0] ??
                leavingItems.find(item => apps.includes(item.child._delegate.app)) ??
                nextActor;
            if (sibling)
                this._box.insert_child_below(header, sibling);
            else
                this._box.add_child(header);
            nextActor = header;

            const members = [header, ...groupItems];
            members.forEach((actor, index) => this._setGroupItemStyle(actor, group,
                index === 0, index === members.length - 1, crossInsets));
        }

        this._groupsStyled = true;
    }

    /**
     * The app icons have an extra padding towards the screen edge (and the
     * opposite one, when the dock is fixed) where the dash background has a
     * margin instead. Compute how much to move from the icons padding to the
     * items margin, so that group backgrounds stay within the dash background.
     *
     * @returns {object[]} for each side across the dock, the item margin and
     * the icon padding, in CSS pixels
     */
    _getGroupCrossInsets() {
        const sides = this._isHorizontal
            ? [St.Side.TOP, St.Side.BOTTOM] : [St.Side.LEFT, St.Side.RIGHT];
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const backgroundNode = this._background.get_theme_node();
        const buttonNode = this._showAppsIcon.toggleButton.get_theme_node();

        return sides.map(side => {
            const padding = buttonNode.get_padding(side) / scaleFactor;
            const margin = Math.min(padding,
                Math.max(0, backgroundNode.get_margin(side) / scaleFactor));
            return {
                name: ['top', 'right', 'bottom', 'left'][side],
                margin,
                padding: padding - margin,
            };
        });
    }

    _setGroupItemStyle(actor, group, isFirst, isLast, crossInsets) {
        const isHeader = actor instanceof DockGroupHeader;

        if (!group) {
            actor.set_style(null);
            if (!isHeader) {
                actor.child?.set_style(null);
                if (!this._isHorizontal)
                    actor.x_align = Clutter.ActorAlign.CENTER;
            }
            return;
        }

        if (!isHeader) {
            actor.child.set_style(crossInsets.map(({name, padding}) =>
                `padding-${name}: ${padding}px;`).join(' '));
            if (!this._isHorizontal)
                actor.x_align = Clutter.ActorAlign.FILL;
        }

        const {settings} = Docking.DockManager;
        const rtl = this._isHorizontal &&
            this.text_direction === Clutter.TextDirection.RTL;
        const [start, end] = this._isHorizontal
            ? rtl ? ['right', 'left'] : ['left', 'right']
            : ['top', 'bottom'];
        const sides = this._isHorizontal ? ['top', 'bottom'] : ['left', 'right'];

        const bg = AppGroups.parseHexColor(group.color);
        const bd = AppGroups.parseHexColor(group.borderColor);
        const opacity = Utils.clampDouble(group.opacity ?? 0.8);
        const borderWidth = Math.max(0, group.borderWidth ?? 1);
        const border = `solid rgba(${bd.r}, ${bd.g}, ${bd.b}, 0.8)`;
        const radius = Math.max(0, settings.groupCornerRadius);
        const startRadius = isFirst ? radius : 0;
        const endRadius = isLast ? radius : 0;

        // corners order: top-left, top-right, bottom-right, bottom-left
        let corners;
        if (!this._isHorizontal)
            corners = [startRadius, startRadius, endRadius, endRadius];
        else if (rtl)
            corners = [endRadius, startRadius, startRadius, endRadius];
        else
            corners = [startRadius, endRadius, endRadius, startRadius];

        // Box spacing is replaced by padding, so that the background has no
        // holes between the group items.
        const iconsDistance = isHeader ? 0 : 2;

        actor.set_style([
            `background-color: rgba(${bg.r}, ${bg.g}, ${bg.b}, ${opacity});`,
            `border-radius: ${corners.map(c => `${c}px`).join(' ')};`,
            ...sides.map(side => `border-${side}: ${borderWidth}px ${border};`),
            `border-${start}: ${isFirst ? borderWidth : 0}px ${border};`,
            `border-${end}: ${isLast ? borderWidth : 0}px ${border};`,
            ...crossInsets.map(({name, margin}) => `margin-${name}: ${margin}px;`),
            `margin-${start}: 0;`,
            `margin-${end}: ${isLast ? Math.max(0, settings.groupSpacing) : 0}px;`,
            `padding-${start}: ${iconsDistance}px;`,
            `padding-${end}: ${iconsDistance}px;`,
        ].join(' '));
    }

    /**
     * Update the dash after the groups configuration changed
     */
    updateGroups() {
        this._queueRedisplay();
    }

    _updateNumberOverlay() {
        const appIcons = this.getAppIcons();
        let counter = 1;
        appIcons.forEach(icon => {
            if (counter < 10) {
                icon.setNumberOverlay(counter);
                counter++;
            } else if (counter === 10) {
                icon.setNumberOverlay(0);
                counter++;
            } else {
                // No overlay after 10
                icon.setNumberOverlay(-1);
            }
            icon.updateNumberOverlay();
        });
    }

    toggleNumberOverlay(activate) {
        const appIcons = this.getAppIcons();
        appIcons.forEach(icon => {
            icon.toggleNumberOverlay(activate);
        });
    }

    _initializeIconSize(maxSize) {
        const maxAllowed = baseIconSizes[baseIconSizes.length - 1];
        maxSize = Math.min(maxSize, maxAllowed);

        if (Docking.DockManager.settings.iconSizeFixed) {
            this._availableIconSizes = [maxSize];
        } else {
            this._availableIconSizes = baseIconSizes.filter(val => {
                return val < maxSize;
            });
            this._availableIconSizes.push(maxSize);
        }
    }

    setIconSize(maxSize, doNotAnimate) {
        this._initializeIconSize(maxSize);

        if (doNotAnimate)
            this._shownInitially = false;

        this._queueRedisplay();
    }

    /**
     * Reset the displayed apps icon to maintain the correct order when changing
     * show favorites/show running settings
     */
    resetAppIcons() {
        const children = this._box.get_children().filter(actor => {
            return actor.child &&
                   !!actor.child.icon;
        });
        for (let i = 0; i < children.length; i++) {
            const item = children[i];
            item.destroy();
        }

        // to avoid ugly animations, just suppress them like when dash is first loaded.
        this._shownInitially = false;
        this._redisplay();
    }

    get showAppsButton() {
        return this._showAppsIcon.toggleButton;
    }

    showShowAppsButton() {
        this._showAppsIcon.visible = true;
        this._showAppsIcon.show(true);
        this.updateShowAppsButton();
    }

    hideShowAppsButton() {
        this._showAppsIcon.visible = false;
    }

    get maxWidth() {
        return this._maxWidth;
    }

    get maxHeight() {
        return this._maxHeight;
    }

    set maxWidth(maxWidth) {
        this.setMaxSize(maxWidth, this._maxHeight);
    }

    set maxHeight(maxHeight) {
        this.setMaxSize(this._maxWidth, maxHeight);
    }

    setMaxSize(maxWidth, maxHeight) {
        if (this._maxWidth === maxWidth &&
            this._maxHeight === maxHeight)
            return;

        this._maxWidth = maxWidth;
        this._maxHeight = maxHeight;
        this._queueRedisplay();
    }

    updateShowAppsButton() {
        if (this._showAppsIcon.get_parent() && !this._showAppsIcon.visible)
            return;

        const {settings} = Docking.DockManager;
        const notifiedProperties = [];
        const showAppsContainer = settings.showAppsAlwaysInTheEdge || !settings.dockExtended
            ? this._dashContainer : this._boxContainer;
        const needsFirstLastChildWorkaround = Config.PACKAGE_VERSION.split('.')[0] < 49;

        if (needsFirstLastChildWorkaround) {
            this._signalsHandler.addWithLabel(Labels.FIRST_LAST_CHILD_WORKAROUND,
                showAppsContainer, 'notify',
                (_obj, pspec) => notifiedProperties.push(pspec.name));
        }

        if (this._showAppsIcon.get_parent() !== showAppsContainer) {
            this._showAppsIcon.get_parent()?.remove_child(this._showAppsIcon);

            if (Docking.DockManager.settings.showAppsAtTop)
                showAppsContainer.insert_child_below(this._showAppsIcon, null);
            else
                showAppsContainer.insert_child_above(this._showAppsIcon, null);
        } else if (settings.showAppsAtTop) {
            showAppsContainer.set_child_below_sibling(this._showAppsIcon, null);
        } else {
            showAppsContainer.set_child_above_sibling(this._showAppsIcon, null);
        }

        if (needsFirstLastChildWorkaround) {
            this._signalsHandler.removeWithLabel(Labels.FIRST_LAST_CHILD_WORKAROUND);

            // This is indeed ugly, but we need to ensure that the last and first
            // visible widgets are re-computed by St, that is buggy because of a
            // mutter issue that is being fixed:
            // https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/2047
            if (!notifiedProperties.includes('first-child'))
                showAppsContainer.notify('first-child');
            if (!notifiedProperties.includes('last-child'))
                showAppsContainer.notify('last-child');
        }
    }
});


/**
 * This is a copy of the same function in utils.js, but also adjust horizontal scrolling
 * and perform few further checks on the current value to avoid changing the values when
 * it would be clamp to the current one in any case.
 * Return the amount of shift applied
 *
 * @param scrollView
 * @param actor
 */
function ensureActorVisibleInScrollView(scrollView, actor) {
    // access to scrollView.[hv]scroll was deprecated in gnome 46
    // instead, adjustment can be accessed directly
    // keep old way for backwards compatibility (gnome <= 45)
    const vAdjustment = scrollView.vadjustment ?? scrollView.vscroll.adjustment;
    const hAdjustment = scrollView.hadjustment ?? scrollView.hscroll.adjustment;
    const {value: vValue0, pageSize: vPageSize, upper: vUpper} = vAdjustment;
    const {value: hValue0, pageSize: hPageSize, upper: hUpper} = hAdjustment;
    let [hValue, vValue] = [hValue0, vValue0];
    let vOffset = 0;
    let hOffset = 0;

    const fade = scrollView.get_effect('fade');
    if (fade) {
        vOffset = fade.fade_margins.top;
        hOffset = fade.fade_margins.left;
    }

    const box = actor.get_allocation_box();
    let {y1} = box, {y2} = box, {x1} = box, {x2} = box;

    let parent = actor.get_parent();
    while (parent !== scrollView) {
        if (!parent)
            throw new Error('Actor not in scroll view');

        const parentBox = parent.get_allocation_box();
        y1 += parentBox.y1;
        y2 += parentBox.y1;
        x1 += parentBox.x1;
        x2 += parentBox.x1;
        parent = parent.get_parent();
    }

    if (y1 < vValue + vOffset)
        vValue = Math.max(0, y1 - vOffset);
    else if (vValue < vUpper - vPageSize && y2 > vValue + vPageSize - vOffset)
        vValue = Math.min(vUpper - vPageSize, y2 + vOffset - vPageSize);

    if (x1 < hValue + hOffset)
        hValue = Math.max(0, x1 - hOffset);
    else if (hValue < hUpper - hPageSize && x2 > hValue + hPageSize - hOffset)
        hValue = Math.min(hUpper - hPageSize, x2 + hOffset - hPageSize);

    if (vValue !== vValue0) {
        vAdjustment.ease(vValue, {
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: Util.SCROLL_TIME,
        });
    }

    if (hValue !== hValue0) {
        hAdjustment.ease(hValue, {
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: Util.SCROLL_TIME,
        });
    }

    return [hValue - hValue0, vValue - vValue0];
}
