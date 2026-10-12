// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {
    ExtensionPreferences,

    // Use __ () and N__() for the extension gettext domain, and reuse
    // the shell domain with the default _() and N_()
    gettext as __,
    ngettext,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as AppGroups from './appGroups.js';

const SCALE_UPDATE_TIMEOUT = 500;
const DEFAULT_ICONS_SIZES = [128, 96, 64, 48, 32, 24, 16];

const TransparencyMode = Object.freeze({
    DEFAULT: 0,
    FIXED: 1,
    DYNAMIC: 3,
});

const RunningIndicatorStyle = Object.freeze({
    DEFAULT: 0,
    DOTS: 1,
    SQUARES: 2,
    DASHES: 3,
    SEGMENTED: 4,
    SOLID: 5,
    CILIORA: 6,
    METRO: 7,
});

const MonitorsConfig = GObject.registerClass({
    Signals: {
        'updated': {},
    },
}, class MonitorsConfig extends GObject.Object {
    static get XML_INTERFACE() {
        return '<node>\
            <interface name="org.gnome.Mutter.DisplayConfig">\
                <method name="GetCurrentState">\
                <arg name="serial" direction="out" type="u" />\
                <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})" />\
                <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})" />\
                <arg name="properties" direction="out" type="a{sv}" />\
                </method>\
                <signal name="MonitorsChanged" />\
            </interface>\
        </node>';
    }

    static get ProxyWrapper() {
        return Gio.DBusProxy.makeProxyWrapper(MonitorsConfig.XML_INTERFACE);
    }

    constructor() {
        super();

        this._monitorsConfigProxy = new MonitorsConfig.ProxyWrapper(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig'
        );

        // Connecting to a D-Bus signal
        this._monitorsConfigProxy.connectSignal('MonitorsChanged',
            () => this._updateResources());

        this._primaryMonitor = null;
        this._monitors = [];
        this._logicalMonitors = [];

        this._updateResources();
    }

    _updateResources() {
        this._monitorsConfigProxy.GetCurrentStateRemote((resources, err) => {
            if (err) {
                logError(err);
                return;
            }

            const [serial_, monitors, logicalMonitors] = resources;
            let index = 0;
            for (const monitor of monitors) {
                const [monitorSpecs, modes_, props] = monitor;
                const [connector, vendor, product, serial] = monitorSpecs;
                this._monitors.push({
                    index: index++,
                    active: false,
                    connector, vendor, product, serial,
                    displayName: props['display-name'].unpack(),
                });
            }

            for (const logicalMonitor of logicalMonitors) {
                const [x_, y_, scale_, transform_, isPrimary, monitorsSpecs] =
                    logicalMonitor;

                // We only care about the first one really
                for (const monitorSpecs of monitorsSpecs) {
                    const [connector, vendor, product, serial] = monitorSpecs;
                    const monitor = this._monitors.find(m =>
                        m.connector === connector && m.vendor === vendor &&
                        m.product === product && m.serial === serial);

                    if (monitor) {
                        monitor.active = true;
                        monitor.isPrimary = isPrimary;
                        if (monitor.isPrimary)
                            this._primaryMonitor = monitor;
                        break;
                    }
                }
            }

            const activeMonitors = this._monitors.filter(m => m.active);
            if (activeMonitors.length > 1 && logicalMonitors.length === 1) {
                // We're in cloning mode, so let's just activate the primary monitor
                this._monitors.forEach(m => (m.active = false));
                this._primaryMonitor.active = true;
            }

            this._updateMonitorsIndexes();
            this.emit('updated');
        });
    }

    _updateMonitorsIndexes() {
        // This function ensures that we follow the old Gdk indexing strategy
        // for monitors, it can be removed when we don't care about breaking
        // old user configurations or external apps configuring this extension
        // such as ubuntu's gnome-control-center.
        const {index: primaryMonitorIndex} = this._primaryMonitor;
        for (const monitor of this._monitors) {
            let {index} = monitor;
            // The The dock uses the Gdk index for monitors, where the primary monitor
            // always has index 0, so let's follow what dash-to-dock-with-groups does in docking.js
            // (as part of _createDocks), but using inverted math
            index -= primaryMonitorIndex;

            if (index < 0)
                index += this._monitors.length;

            monitor.index = index;
        }
    }

    get primaryMonitor() {
        return this._primaryMonitor;
    }

    get monitors() {
        return this._monitors;
    }
});

/**
 * @param settings
 */
function setShortcut(settings) {
    const shortcutText = settings.get_string('shortcut-text');
    const [success, key, mods] = Gtk.accelerator_parse(shortcutText);

    if (success && Gtk.accelerator_valid(key, mods)) {
        const shortcut = Gtk.accelerator_name(key, mods);
        settings.set_strv('shortcut', [shortcut]);
    } else {
        settings.set_strv('shortcut', []);
    }
}

const DockSettings = GObject.registerClass({
    Implements: [Gtk.BuilderScope],
}, class DashToDockSettings extends GObject.Object {
    _init(extensionPreferences) {
        super._init();

        this._extensionPreferences = extensionPreferences;
        this._settings = extensionPreferences.getSettings(
            'org.gnome.shell.extensions.dash-to-dock-with-groups');
        this._appSwitcherSettings = new Gio.Settings({schema_id: 'org.gnome.shell.app-switcher'});
        this._rtl = Gtk.Widget.get_default_direction() === Gtk.TextDirection.RTL;

        this._builder = new Gtk.Builder();
        this._builder.set_scope(this);
        this._builder.set_translation_domain(
            extensionPreferences.metadata['gettext-domain']);
        this._builder.add_from_file(`${extensionPreferences.path}/Settings.ui`);

        const notebook = this._builder.get_object('settings_notebook');
        // Groups tab goes right before the About one
        notebook.insert_page(new GroupsPage(this._settings),
            new Gtk.Label({label: __('Groups')}), notebook.get_n_pages() - 1);
        const group = new Adw.PreferencesGroup();
        group.add(notebook);
        this.page = new Adw.PreferencesPage();
        this.page.add(group);

        // Set a reasonable initial window height
        this.page.connect('realize', () => {
            const rootWindow = this.page.get_root();
            rootWindow.set_default_size(-1, 850);
            rootWindow.connect('close-request', () => this._onWindowsClosed());
        });

        // Timeout to delay the update of the settings
        this._dock_size_timeout = 0;
        this._icon_size_timeout = 0;
        this._opacity_timeout = 0;

        this._monitorsConfig = new MonitorsConfig();
        this._bindSettings();
    }

    _onWindowsClosed() {
        if (this._dock_size_timeout) {
            GLib.source_remove(this._dock_size_timeout);
            delete this._dock_size_timeout;
        }

        if (this._icon_size_timeout) {
            GLib.source_remove(this._icon_size_timeout);
            delete this._icon_size_timeout;
        }

        if (this._opacity_timeout) {
            GLib.source_remove(this._opacity_timeout);
            delete this._opacity_timeout;
        }
    }

    vfunc_create_closure(builder, handlerName, flags, connectObject) {
        if (flags & Gtk.BuilderClosureFlags.SWAPPED)
            throw new Error('Unsupported template signal flag "swapped"');

        if (typeof this[handlerName] === 'undefined')
            throw new Error(`${handlerName} is undefined`);

        return this[handlerName].bind(connectObject || this);
    }

    dock_display_combo_changed_cb(combo) {
        if (!this._monitors?.length || this._updatingSettings)
            return;

        const preferredMonitor = this._monitors[combo.get_active()].connector;

        this._updatingSettings = true;
        this._settings.set_string('preferred-monitor-by-connector', preferredMonitor);
        this._settings.set_int('preferred-monitor', -2);
        this._updatingSettings = false;
    }

    position_top_button_toggled_cb(button) {
        if (button.get_active())
            this._settings.set_enum('dock-position', 0);
    }

    position_right_button_toggled_cb(button) {
        if (button.get_active())
            this._settings.set_enum('dock-position', 1);
    }

    position_bottom_button_toggled_cb(button) {
        if (button.get_active())
            this._settings.set_enum('dock-position', 2);
    }

    position_left_button_toggled_cb(button) {
        if (button.get_active())
            this._settings.set_enum('dock-position', 3);
    }

    icon_size_combo_changed_cb(combo) {
        this._settings.set_int('dash-max-icon-size', this._allIconSizes[combo.get_active()]);
    }

    dock_size_scale_value_changed_cb(scale) {
        // Avoid settings the size continuously
        if (this._dock_size_timeout > 0)
            GLib.source_remove(this._dock_size_timeout);
        this._dock_size_timeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SCALE_UPDATE_TIMEOUT, () => {
                this._settings.set_double('height-fraction', scale.get_value());
                this._dock_size_timeout = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    icon_size_scale_value_changed_cb(scale) {
        // Avoid settings the size consinuosly
        if (this._icon_size_timeout > 0)
            GLib.source_remove(this._icon_size_timeout);
        this._icon_size_timeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SCALE_UPDATE_TIMEOUT, () => {
                this._settings.set_int('dash-max-icon-size', scale.get_value());
                this._icon_size_timeout = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    preview_size_scale_format_value_cb(scale, value) {
        return value === 0 ? 'auto' : value;
    }

    preview_size_scale_value_changed_cb(scale) {
        this._settings.set_double('preview-size-scale', scale.get_value());
    }

    custom_opacity_scale_value_changed_cb(scale) {
        // Avoid settings the opacity consinuosly as it's change is animated
        if (this._opacity_timeout > 0)
            GLib.source_remove(this._opacity_timeout);
        this._opacity_timeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SCALE_UPDATE_TIMEOUT, () => {
                this._settings.set_double('background-opacity', scale.get_value());
                this._opacity_timeout = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    min_opacity_scale_value_changed_cb(scale) {
        // Avoid settings the opacity consinuosly as it's change is animated
        if (this._opacity_timeout > 0)
            GLib.source_remove(this._opacity_timeout);
        this._opacity_timeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SCALE_UPDATE_TIMEOUT, () => {
                this._settings.set_double('min-alpha', scale.get_value());
                this._opacity_timeout = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    max_opacity_scale_value_changed_cb(scale) {
        // Avoid settings the opacity consinuosly as it's change is animated
        if (this._opacity_timeout > 0)
            GLib.source_remove(this._opacity_timeout);
        this._opacity_timeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SCALE_UPDATE_TIMEOUT, () => {
                this._settings.set_double('max-alpha', scale.get_value());
                this._opacity_timeout = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    all_windows_radio_button_toggled_cb(button) {
        if (button.get_active())
            this._settings.set_enum('intellihide-mode', 0);
    }

    focus_application_windows_radio_button_toggled_cb(button) {
        if (button.get_active())
            this._settings.set_enum('intellihide-mode', 1);
    }

    maximized_windows_radio_button_toggled_cb(button) {
        if (button.get_active())
            this._settings.set_enum('intellihide-mode', 2);
    }

    always_on_top_radio_button_toggled_cb(button) {
        if (button.get_active())
            this._settings.set_enum('intellihide-mode', 3);
    }

    _updateMonitorsSettings() {
        // Monitor options
        const preferredMonitor = this._settings.get_int('preferred-monitor');
        const preferredMonitorByConnector = this._settings.get_string('preferred-monitor-by-connector');
        const dockMonitorCombo = this._builder.get_object('dock_monitor_combo');

        this._monitors = [];
        dockMonitorCombo.remove_all();
        let primaryIndex = -1;

        // Add connected monitors
        for (const monitor of this._monitorsConfig.monitors) {
            if (!monitor.active && monitor.index !== preferredMonitor)
                continue;

            if (monitor.isPrimary) {
                dockMonitorCombo.append_text(
                    /* TRANSLATORS: This will be followed by Display Name - Connector. */
                    `${__('Primary monitor: ') + monitor.displayName} - ${
                        monitor.connector}`);
                primaryIndex = this._monitors.length;
            } else {
                dockMonitorCombo.append_text(
                    /* TRANSLATORS: Followed by monitor index, Display Name - Connector. */
                    `${__('Secondary monitor ') + (monitor.index + 1)} - ${
                        monitor.displayName} - ${monitor.connector}`);
            }

            this._monitors.push(monitor);

            if (monitor.index === preferredMonitor ||
                (preferredMonitor === -2 && preferredMonitorByConnector === monitor.connector))
                dockMonitorCombo.set_active(this._monitors.length - 1);
        }

        if (dockMonitorCombo.get_active() < 0 && primaryIndex >= 0)
            dockMonitorCombo.set_active(primaryIndex);
    }

    _update_scroll_action_warning() {
        const sensitive = !this._builder.get_object('icon_size_fixed_checkbutton').get_active();
        this._builder.get_object('note_about_fixed_size_icon').set_visible(!sensitive);
    }

    _bindSettings() {
        // Position and size panel

        this._updateMonitorsSettings();
        this._monitorsConfig.connect('updated',
            () => this._updateMonitorsSettings());
        this._settings.connect('changed::preferred-monitor',
            () => this._updateMonitorsSettings());
        this._settings.connect('changed::preferred-monitor-by-connector',
            () => this._updateMonitorsSettings());

        // Position option
        const position = this._settings.get_enum('dock-position');

        switch (position) {
        case 0:
            this._builder.get_object('position_top_button').set_active(true);
            break;
        case 1:
            this._builder.get_object('position_right_button').set_active(true);
            break;
        case 2:
            this._builder.get_object('position_bottom_button').set_active(true);
            break;
        case 3:
            this._builder.get_object('position_left_button').set_active(true);
            break;
        }

        if (this._rtl) {
            /* Left is Right in rtl as a setting */
            this._builder.get_object('position_left_button').set_label(__('Right'));
            this._builder.get_object('position_right_button').set_label(__('Left'));
        }

        // Intelligent autohide options
        this._settings.bind('dock-fixed',
            this._builder.get_object('intelligent_autohide_switch'),
            'active',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this._settings.bind('dock-fixed',
            this._builder.get_object('intelligent_autohide_button'),
            'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this._settings.bind('autohide',
            this._builder.get_object('autohide_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('autohide-in-fullscreen',
            this._builder.get_object('autohide_enable_in_fullscreen_checkbutton'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-dock-urgent-notify',
            this._builder.get_object('show_dock_urgent_notify_checkbutton'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('require-pressure-to-show',
            this._builder.get_object('require_pressure_checkbutton'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('intellihide',
            this._builder.get_object('intellihide_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('animation-time',
            this._builder.get_object('animation_duration_spinbutton'),
            'value',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('hide-delay',
            this._builder.get_object('hide_timeout_spinbutton'),
            'value',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-delay',
            this._builder.get_object('show_timeout_spinbutton'),
            'value',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('pressure-threshold',
            this._builder.get_object('pressure_threshold_spinbutton'),
            'value',
            Gio.SettingsBindFlags.DEFAULT);

        // this._builder.get_object('animation_duration_spinbutton').set_value(
        //   this._settings.get_double('animation-time'));

        // Create dialog for intelligent autohide advanced settings
        this._builder.get_object('intelligent_autohide_button').connect('clicked', () => {
            const dialog = new Gtk.Dialog({
                title: __('Intelligent autohide customization'),
                transient_for: this.page.get_root(),
                use_header_bar: true,
                modal: true,
            });

            // GTK+ leaves positive values for application-defined response ids.
            // Use +1 for the reset action
            dialog.add_button(__('Reset to defaults'), 1);

            const box = this._builder.get_object('intelligent_autohide_advanced_settings_box');
            dialog.get_content_area().append(box);

            this._settings.bind('intellihide',
                this._builder.get_object('intellihide_mode_box'),
                'sensitive',
                Gio.SettingsBindFlags.GET);

            // intellihide mode

            const intellihideModeRadioButtons = [
                this._builder.get_object('all_windows_radio_button'),
                this._builder.get_object('focus_application_windows_radio_button'),
                this._builder.get_object('maximized_windows_radio_button'),
                this._builder.get_object('always_on_top_radio_button'),
            ];

            intellihideModeRadioButtons[this._settings.get_enum('intellihide-mode')].set_active(true);

            this._settings.bind('autohide',
                this._builder.get_object('require_pressure_checkbutton'),
                'sensitive',
                Gio.SettingsBindFlags.GET);

            this._settings.bind('autohide',
                this._builder.get_object('autohide_enable_in_fullscreen_checkbutton'),
                'sensitive',
                Gio.SettingsBindFlags.GET);

            this._settings.bind('autohide',
                this._builder.get_object('show_dock_urgent_notify_checkbutton'),
                'sensitive',
                Gio.SettingsBindFlags.GET);

            this._settings.bind('require-pressure-to-show',
                this._builder.get_object('show_timeout_spinbutton'),
                'sensitive',
                Gio.SettingsBindFlags.INVERT_BOOLEAN);
            this._settings.bind('require-pressure-to-show',
                this._builder.get_object('show_timeout_label'),
                'sensitive',
                Gio.SettingsBindFlags.INVERT_BOOLEAN);
            this._settings.bind('require-pressure-to-show',
                this._builder.get_object('pressure_threshold_spinbutton'),
                'sensitive',
                Gio.SettingsBindFlags.DEFAULT);
            this._settings.bind('require-pressure-to-show',
                this._builder.get_object('pressure_threshold_label'),
                'sensitive',
                Gio.SettingsBindFlags.DEFAULT);

            dialog.connect('response', (_, id) => {
                if (id === 1) {
                    // restore default settings for the relevant keys
                    const keys = ['intellihide', 'autohide', 'intellihide-mode',
                        'autohide-in-fullscreen', 'show-dock-urgent-notify',
                        'require-pressure-to-show', 'animation-time',
                        'show-delay', 'hide-delay', 'pressure-threshold'];
                    keys.forEach(function (val) {
                        this._settings.set_value(val, this._settings.get_default_value(val));
                    }, this);
                    intellihideModeRadioButtons[this._settings.get_enum('intellihide-mode')].set_active(true);
                } else {
                    // remove the settings box so it doesn't get destroyed;
                    dialog.get_content_area().remove(box);
                    dialog.destroy();
                }
            });

            dialog.present();
        });

        // size options
        const dockSizeScale = this._builder.get_object('dock_size_scale');
        dockSizeScale.set_value(this._settings.get_double('height-fraction'));
        dockSizeScale.add_mark(0.9, Gtk.PositionType.TOP, null);
        dockSizeScale.set_format_value_func((_, value) => {
            return `${Math.round(value * 100)} %`;
        });
        const iconSizeScale = this._builder.get_object('icon_size_scale');
        iconSizeScale.set_range(8, DEFAULT_ICONS_SIZES[0]);
        iconSizeScale.set_value(this._settings.get_int('dash-max-icon-size'));
        DEFAULT_ICONS_SIZES.forEach(val => {
            iconSizeScale.add_mark(val, Gtk.PositionType.TOP, val.toString());
        });
        iconSizeScale.set_format_value_func((_, value) => {
            return `${value} px`;
        });
        this._builder.get_object('preview_size_scale').set_value(
            this._settings.get_double('preview-size-scale'));

        // Corrent for rtl languages
        if (this._rtl) {
            // Flip value position: this is not done automatically
            dockSizeScale.set_value_pos(Gtk.PositionType.LEFT);
            iconSizeScale.set_value_pos(Gtk.PositionType.LEFT);
            // I suppose due to a bug, having a more than one mark and one above
            // a value of 100 makes the rendering of the marks wrong in rtl.
            // This doesn't happen setting the scale as not flippable
            // and then manually inverting it
            iconSizeScale.set_flippable(false);
            iconSizeScale.set_inverted(true);
        }

        this._settings.bind('icon-size-fixed',
            this._builder.get_object('icon_size_fixed_checkbutton'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('extend-height',
            this._builder.get_object('dock_size_extend_checkbutton'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('extend-height',
            this._builder.get_object('dock_size_scale'),
            'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this._settings.bind('always-center-icons',
            this._builder.get_object('dock_center_icons_check'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('extend-height',
            this._builder.get_object('dock_center_icons_check'),
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT);

        this._settings.bind('multi-monitor',
            this._builder.get_object('dock_monitor_combo'),
            'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);


        // Apps panel

        this._settings.bind('show-running',
            this._builder.get_object('show_running_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        const applicationButtonIsolationButton =
            this._builder.get_object('application_button_isolation_button');
        const applicationButtonIsolationLabel =
            applicationButtonIsolationButton.label;

        const hasIsolationOverride = () =>
            this._settings.get_user_value('isolate-workspaces') !== null;
        const gnomeIsolation = () =>
            this._appSwitcherSettings.get_boolean('current-workspace-only');

        let updatingIsolationButton = false;
        const updateIsolationButton = () => {
            updatingIsolationButton = true;
            applicationButtonIsolationButton.active = hasIsolationOverride()
                ? this._settings.get_boolean('isolate-workspaces')
                : gnomeIsolation();
            updatingIsolationButton = false;
            applicationButtonIsolationButton.label = hasIsolationOverride()
                ? applicationButtonIsolationLabel
                : `${applicationButtonIsolationLabel}\n${
                    __('Follows GNOME Multitasking\'s Application Switching setting.')}`;
        };
        applicationButtonIsolationButton.connect('notify::active', check => {
            if (updatingIsolationButton)
                return;
            if (check.active === gnomeIsolation())
                this._settings.reset('isolate-workspaces');
            else
                this._settings.set_boolean('isolate-workspaces', check.active);
        });
        updateIsolationButton();
        this._settings.connect('changed::isolate-workspaces',
            updateIsolationButton);
        this._appSwitcherSettings.connect('changed::current-workspace-only',
            updateIsolationButton);
        this._settings.bind('workspace-agnostic-urgent-windows',
            this._builder.get_object('application_button_urgent_button'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('isolate-monitors',
            this._builder.get_object('application_button_monitor_isolation_button'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-windows-preview',
            this._builder.get_object('windows_preview_button'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('multi-monitor',
            this._builder.get_object('multi_monitor_button'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-favorites',
            this._builder.get_object('show_favorite_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-trash',
            this._builder.get_object('show_trash_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-mounts',
            this._builder.get_object('show_mounts_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-mounts-only-mounted',
            this._builder.get_object('show_only_mounted_devices_check'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-mounts-network',
            this._builder.get_object('show_network_volumes_check'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('isolate-locations',
            this._builder.get_object('isolate_locations_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        const isolateLocationsBindings = ['show_trash_switch', 'show_mounts_switch'];
        const updateIsolateLocations = () => {
            this._builder.get_object('isolate_locations_row').sensitive =
                isolateLocationsBindings.some(s => this._builder.get_object(s).active);
        };
        updateIsolateLocations();
        isolateLocationsBindings.forEach(s => this._builder.get_object(s).connect(
            'notify::active', () => updateIsolateLocations()));
        this._settings.bind('dance-urgent-applications',
            this._builder.get_object('wiggle_urgent_applications_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('hide-tooltip',
            this._builder.get_object('hide_tooltip_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-icons-emblems',
            this._builder.get_object('show_icons_emblems_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        const notificationsCounterCheck = this._builder.get_object(
            'notifications_counter_check');
        this._settings.bind('show-icons-notifications-counter',
            notificationsCounterCheck,
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-icons-emblems',
            notificationsCounterCheck,
            'sensitive',
            Gio.SettingsBindFlags.GET);

        const applicationsOverrideCounter =
            this._builder.get_object('applications_override_counter');
        this._settings.bind('application-counter-overrides-notifications',
            applicationsOverrideCounter,
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        notificationsCounterCheck.bind_property('active',
            applicationsOverrideCounter, 'sensitive',
            GObject.BindingFlags.SYNC_CREATE);
        this._settings.connect('changed::show-icons-emblems', () => {
            if (this._settings.get_boolean('show-icons-emblems'))
                applicationsOverrideCounter.sensitive = notificationsCounterCheck.active;
            else
                applicationsOverrideCounter.sensitive = false;
        });
        this._settings.bind('show-show-apps-button',
            this._builder.get_object('show_applications_button_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-apps-at-top',
            this._builder.get_object('application_button_first_button'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-show-apps-button',
            this._builder.get_object('application_button_first_button'),
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-show-apps-button',
            this._builder.get_object('application_button_animation_button'),
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-apps-always-in-the-edge',
            this._builder.get_object('show_apps_always_in_the_edge'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-show-apps-button',
            this._builder.get_object('show_apps_always_in_the_edge'),
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('scroll-to-focused-application',
            this._builder.get_object('scroll_to_icon_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);


        // Behavior panel

        this._settings.bind('hot-keys',
            this._builder.get_object('hot_keys_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('hot-keys',
            this._builder.get_object('overlay_button'),
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT);

        this._builder.get_object('click_action_combo').set_active(this._settings.get_enum('click-action'));
        this._builder.get_object('click_action_combo').connect('changed', widget => {
            this._settings.set_enum('click-action', widget.get_active());
        });

        this._builder.get_object('icon_size_fixed_checkbutton').connect('toggled', () => {
            this._update_scroll_action_warning();
        });
        this._update_scroll_action_warning();

        this._builder.get_object('scroll_action_combo').set_active(this._settings.get_enum('scroll-action'));
        this._builder.get_object('scroll_action_combo').connect('changed', widget => {
            this._settings.set_enum('scroll-action', widget.get_active());
        });

        this._builder.get_object('shift_click_action_combo').connect('changed', widget => {
            this._settings.set_enum('shift-click-action', widget.get_active());
        });

        this._builder.get_object('middle_click_action_combo').connect('changed', widget => {
            this._settings.set_enum('middle-click-action', widget.get_active());
        });
        this._builder.get_object('shift_middle_click_action_combo').connect('changed', widget => {
            this._settings.set_enum('shift-middle-click-action', widget.get_active());
        });

        // Create dialog for number overlay options
        this._builder.get_object('overlay_button').connect('clicked', () => {
            const dialog = new Gtk.Dialog({
                title: __('Show dock and application numbers'),
                transient_for: this.page.get_root(),
                use_header_bar: true,
                modal: true,
            });

            // GTK+ leaves positive values for application-defined response ids.
            // Use +1 for the reset action
            dialog.add_button(__('Reset to defaults'), 1);

            const box = this._builder.get_object('box_overlay_shortcut');
            dialog.get_content_area().append(box);

            this._builder.get_object('overlay_switch').set_active(
                this._settings.get_boolean('hotkeys-overlay'));
            this._builder.get_object('show_dock_switch').set_active(
                this._settings.get_boolean('hotkeys-show-dock'));

            // We need to update the shortcut 'strv' when the text is modified
            this._settings.connect('changed::shortcut-text', () => setShortcut(this._settings));
            this._settings.bind('shortcut-text',
                this._builder.get_object('shortcut_entry'),
                'text',
                Gio.SettingsBindFlags.DEFAULT);

            this._settings.bind('hotkeys-overlay',
                this._builder.get_object('overlay_switch'),
                'active',
                Gio.SettingsBindFlags.DEFAULT);
            this._settings.bind('hotkeys-show-dock',
                this._builder.get_object('show_dock_switch'),
                'active',
                Gio.SettingsBindFlags.DEFAULT);
            this._settings.bind('shortcut-timeout',
                this._builder.get_object('timeout_spinbutton'),
                'value',
                Gio.SettingsBindFlags.DEFAULT);

            dialog.connect('response', (_, id) => {
                if (id === 1) {
                    // restore default settings for the relevant keys
                    const keys = ['shortcut-text', 'hotkeys-overlay',
                        'hotkeys-show-dock', 'shortcut-timeout'];
                    keys.forEach(function (val) {
                        this._settings.set_value(val, this._settings.get_default_value(val));
                    }, this);
                } else {
                    // remove the settings box so it doesn't get destroyed;
                    dialog.get_content_area().remove(box);
                    dialog.destroy();
                }
            });

            dialog.present();
        });

        // Create dialog for middle-click options
        this._builder.get_object('middle_click_options_button').connect('clicked', () => {
            const dialog = new Gtk.Dialog({
                title: __('Customize middle-click behavior'),
                transient_for: this.page.get_root(),
                use_header_bar: true,
                modal: true,
            });

            // GTK+ leaves positive values for application-defined response ids.
            // Use +1 for the reset action
            dialog.add_button(__('Reset to defaults'), 1);

            const box = this._builder.get_object('box_middle_click_options');
            dialog.get_content_area().append(box);

            this._builder.get_object('shift_click_action_combo').set_active(
                this._settings.get_enum('shift-click-action'));

            this._builder.get_object('middle_click_action_combo').set_active(
                this._settings.get_enum('middle-click-action'));

            this._builder.get_object('shift_middle_click_action_combo').set_active(
                this._settings.get_enum('shift-middle-click-action'));

            this._settings.bind('shift-click-action',
                this._builder.get_object('shift_click_action_combo'),
                'active-id',
                Gio.SettingsBindFlags.DEFAULT);
            this._settings.bind('middle-click-action',
                this._builder.get_object('middle_click_action_combo'),
                'active-id',
                Gio.SettingsBindFlags.DEFAULT);
            this._settings.bind('shift-middle-click-action',
                this._builder.get_object('shift_middle_click_action_combo'),
                'active-id',
                Gio.SettingsBindFlags.DEFAULT);

            dialog.connect('response', (_, id) => {
                if (id === 1) {
                    // restore default settings for the relevant keys
                    const keys = ['shift-click-action', 'middle-click-action', 'shift-middle-click-action'];
                    keys.forEach(function (val) {
                        this._settings.set_value(val, this._settings.get_default_value(val));
                    }, this);
                    this._builder.get_object('shift_click_action_combo').set_active(
                        this._settings.get_enum('shift-click-action'));
                    this._builder.get_object('middle_click_action_combo').set_active(
                        this._settings.get_enum('middle-click-action'));
                    this._builder.get_object('shift_middle_click_action_combo').set_active(
                        this._settings.get_enum('shift-middle-click-action'));
                } else {
                    // remove the settings box so it doesn't get destroyed;
                    dialog.get_content_area().remove(box);
                    dialog.destroy();
                }
            });

            dialog.present();
        });

        // Appearance Panel

        this._settings.bind('apply-custom-theme',
            this._builder.get_object('customize_theme'),
            'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN | Gio.SettingsBindFlags.GET);
        this._settings.bind('apply-custom-theme',
            this._builder.get_object('builtin_theme_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('custom-theme-shrink',
            this._builder.get_object('shrink_dash_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        // Running indicators
        this._builder.get_object('running_indicators_combo').set_active(
            this._settings.get_enum('running-indicator-style')
        );
        this._builder.get_object('running_indicators_combo').connect(
            'changed',
            widget => {
                this._settings.set_enum('running-indicator-style', widget.get_active());
            }
        );

        if (this._settings.get_enum('running-indicator-style') === RunningIndicatorStyle.DEFAULT)
            this._builder.get_object('running_indicators_advance_settings_button').set_sensitive(false);

        this._settings.connect('changed::running-indicator-style', () => {
            if (this._settings.get_enum('running-indicator-style') === RunningIndicatorStyle.DEFAULT)
                this._builder.get_object('running_indicators_advance_settings_button').set_sensitive(false);
            else
                this._builder.get_object('running_indicators_advance_settings_button').set_sensitive(true);
        });

        // Create dialog for running indicators advanced settings
        this._builder.get_object('running_indicators_advance_settings_button').connect('clicked', () => {
            const dialog = new Gtk.Dialog({
                title: __('Customize running indicators'),
                transient_for: this.page.get_root(),
                use_header_bar: true,
                modal: true,
            });

            const box = this._builder.get_object('running_dots_advance_settings_box');
            dialog.get_content_area().append(box);

            this._settings.bind('running-indicator-dominant-color',
                this._builder.get_object('dominant_color_switch'),
                'active',
                Gio.SettingsBindFlags.DEFAULT);

            this._settings.bind('custom-theme-customize-running-dots',
                this._builder.get_object('dot_style_switch'),
                'active',
                Gio.SettingsBindFlags.DEFAULT);
            this._settings.bind('custom-theme-customize-running-dots',
                this._builder.get_object('dot_style_settings_box'),
                'sensitive', Gio.SettingsBindFlags.DEFAULT);

            const rgba = new Gdk.RGBA();
            rgba.parse(this._settings.get_string('custom-theme-running-dots-color'));
            this._builder.get_object('dot_color_colorbutton').set_rgba(rgba);

            this._builder.get_object('dot_color_colorbutton').connect('notify::rgba', button => {
                const css = button.rgba.to_string();

                this._settings.set_string('custom-theme-running-dots-color', css);
            });

            rgba.parse(this._settings.get_string('custom-theme-running-dots-border-color'));
            this._builder.get_object('dot_border_color_colorbutton').set_rgba(rgba);

            this._builder.get_object('dot_border_color_colorbutton').connect('notify::rgba', button => {
                const css = button.rgba.to_string();

                this._settings.set_string('custom-theme-running-dots-border-color', css);
            });

            this._settings.bind('custom-theme-running-dots-border-width',
                this._builder.get_object('dot_border_width_spin_button'),
                'value',
                Gio.SettingsBindFlags.DEFAULT);


            dialog.connect('response', () => {
                // remove the settings box so it doesn't get destroyed;
                dialog.get_content_area().remove(box);
                dialog.destroy();
            });

            dialog.present();
        });

        this._settings.bind('custom-background-color',
            this._builder.get_object('custom_background_color_switch'),
            'active', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('custom-background-color',
            this._builder.get_object('custom_background_color'),
            'sensitive', Gio.SettingsBindFlags.DEFAULT);

        const rgba = new Gdk.RGBA();
        rgba.parse(this._settings.get_string('background-color'));
        this._builder.get_object('custom_background_color').set_rgba(rgba);

        this._builder.get_object('custom_background_color').connect('notify::rgba', button => {
            const css = button.rgba.to_string();

            this._settings.set_string('background-color', css);
        });

        // Opacity
        this._builder.get_object('customize_opacity_combo').set_active_id(
            this._settings.get_enum('transparency-mode').toString()
        );
        this._builder.get_object('customize_opacity_combo').connect(
            'changed',
            widget => {
                this._settings.set_enum('transparency-mode', parseInt(widget.get_active_id()));
            }
        );

        const customOpacityScale = this._builder.get_object('custom_opacity_scale');
        customOpacityScale.set_value(this._settings.get_double('background-opacity'));
        customOpacityScale.set_format_value_func((_, value) => {
            return `${Math.round(value * 100)}%`;
        });

        if (this._settings.get_enum('transparency-mode') !== TransparencyMode.FIXED)
            this._builder.get_object('custom_opacity_scale').set_sensitive(false);

        this._settings.connect('changed::transparency-mode', () => {
            if (this._settings.get_enum('transparency-mode') !== TransparencyMode.FIXED)
                this._builder.get_object('custom_opacity_scale').set_sensitive(false);
            else
                this._builder.get_object('custom_opacity_scale').set_sensitive(true);
        });

        if (this._settings.get_enum('transparency-mode') !== TransparencyMode.DYNAMIC)
            this._builder.get_object('dynamic_opacity_button').set_sensitive(false);


        this._settings.connect('changed::transparency-mode', () => {
            if (this._settings.get_enum('transparency-mode') !== TransparencyMode.DYNAMIC)
                this._builder.get_object('dynamic_opacity_button').set_sensitive(false);

            else
                this._builder.get_object('dynamic_opacity_button').set_sensitive(true);
        });

        // Create dialog for transparency advanced settings
        this._builder.get_object('dynamic_opacity_button').connect('clicked', () => {
            const dialog = new Gtk.Dialog({
                title: __('Customize opacity'),
                transient_for: this.page.get_root(),
                use_header_bar: true,
                modal: true,
            });

            const box = this._builder.get_object('advanced_transparency_dialog');
            dialog.get_content_area().append(box);

            this._settings.bind(
                'customize-alphas',
                this._builder.get_object('customize_alphas_switch'),
                'active',
                Gio.SettingsBindFlags.DEFAULT
            );
            this._settings.bind(
                'customize-alphas',
                this._builder.get_object('min_alpha_scale'),
                'sensitive',
                Gio.SettingsBindFlags.DEFAULT
            );
            this._settings.bind(
                'customize-alphas',
                this._builder.get_object('max_alpha_scale'),
                'sensitive',
                Gio.SettingsBindFlags.DEFAULT
            );

            const minAlphaScale = this._builder.get_object('min_alpha_scale');
            const maxAlphaScale = this._builder.get_object('max_alpha_scale');
            minAlphaScale.set_value(
                this._settings.get_double('min-alpha')
            );
            minAlphaScale.set_format_value_func((_, value) => {
                return `${Math.round(value * 100)} %`;
            });
            maxAlphaScale.set_format_value_func((_, value) => {
                return `${Math.round(value * 100)} %`;
            });

            maxAlphaScale.set_value(
                this._settings.get_double('max-alpha')
            );

            dialog.connect('response', () => {
                // remove the settings box so it doesn't get destroyed;
                dialog.get_content_area().remove(box);
                dialog.destroy();
            });

            dialog.present();
        });


        this._settings.bind('unity-backlit-items',
            this._builder.get_object('unity_backlit_items_switch'),
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        this._settings.bind('apply-glossy-effect',
            this._builder.get_object('apply_gloss_effect_checkbutton'),
            'active', Gio.SettingsBindFlags.DEFAULT
        );
        this._settings.bind('unity-backlit-items',
            this._builder.get_object('apply_gloss_effect_checkbutton'),
            'sensitive',
            Gio.SettingsBindFlags.DEFAULT
        );

        this._settings.bind('force-straight-corner',
            this._builder.get_object('force_straight_corner_switch'),
            'active', Gio.SettingsBindFlags.DEFAULT);

        this._settings.bind('disable-overview-on-startup',
            this._builder.get_object('show_overview_on_startup_switch'),
            'active', Gio.SettingsBindFlags.INVERT_BOOLEAN);

        // About Panel

        this._builder.get_object('extension_version').set_label(
            `${this._extensionPreferences.metadata.version}`);
    }
});

/**
 * @param {string} hex a color in the #rrggbb format
 * @returns {Gdk.RGBA} the parsed color
 */
function rgbaFromHex(hex) {
    const rgba = new Gdk.RGBA();
    if (!rgba.parse(hex ?? ''))
        rgba.parse('#333333');
    return rgba;
}

/**
 * @param {Gdk.RGBA} rgba a color
 * @returns {string} the color in the #rrggbb format
 */
function hexFromRgba(rgba) {
    return `#${[rgba.red, rgba.green, rgba.blue].map(c =>
        Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Editor for a single application group: name, style and member apps.
 */
const GroupEditorWindow = GObject.registerClass(
class GroupEditorWindow extends Adw.Window {
    _init(parent, group, installedApps, onSave) {
        super._init({
            title: group ? __('Edit Group') : __('New Group'),
            transient_for: parent,
            modal: true,
            default_width: 520,
            default_height: 680,
        });

        this._group = group ? JSON.parse(JSON.stringify(group)) : {
            ...AppGroups.DEFAULT_GROUP,
            id: AppGroups.generateGroupId(),
            apps: [],
        };
        this._isOtherGroup = AppGroups.isOtherGroup(this._group);
        this._selectedApps = new Set(this._group.apps);
        this._installedApps = [...installedApps].sort((a, b) =>
            a.name.localeCompare(b.name));
        this._onSave = onSave;

        const headerBar = new Adw.HeaderBar({
            show_end_title_buttons: false,
            show_start_title_buttons: false,
        });
        const cancelButton = new Gtk.Button({label: __('Cancel')});
        cancelButton.connect('clicked', () => this.close());
        headerBar.pack_start(cancelButton);

        const saveButton = new Gtk.Button({
            label: __('Save'),
            css_classes: ['suggested-action'],
        });
        saveButton.connect('clicked', () => this._save());
        headerBar.pack_end(saveButton);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        const settingsGroup = new Adw.PreferencesGroup();
        content.append(settingsGroup);

        this._nameRow = new Adw.EntryRow({
            title: __('Name'),
            text: this._group.name,
        });
        this._nameRow.connect('changed', () => this._nameRow.remove_css_class('error'));
        settingsGroup.add(this._nameRow);

        const makeColorRow = (title, hex) => {
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false}),
                rgba: rgbaFromHex(hex),
                valign: Gtk.Align.CENTER,
            });
            const row = new Adw.ActionRow({title});
            row.add_suffix(button);
            row.set_activatable_widget(button);
            settingsGroup.add(row);
            return button;
        };
        this._colorButton = makeColorRow(__('Background color'), this._group.color);
        this._borderColorButton = makeColorRow(__('Border color'), this._group.borderColor);

        this._opacityRow = Adw.SpinRow.new_with_range(0, 1, 0.05);
        this._opacityRow.title = __('Background opacity');
        this._opacityRow.digits = 2;
        this._opacityRow.value = this._group.opacity;
        settingsGroup.add(this._opacityRow);

        this._borderWidthRow = Adw.SpinRow.new_with_range(0, 5, 1);
        this._borderWidthRow.title = __('Border width');
        this._borderWidthRow.value = this._group.borderWidth;
        settingsGroup.add(this._borderWidthRow);

        if (this._isOtherGroup) {
            content.append(new Gtk.Label({
                label: __('Applications are automatically assigned to this group: ' +
                    'any application that is not in another group appears here.'),
                wrap: true,
                css_classes: ['dim-label'],
            }));
            this.default_height = 400;
        } else {
            content.append(new Gtk.Label({
                label: __('Applications'),
                xalign: 0,
                css_classes: ['heading'],
            }));

            this._searchEntry = new Gtk.SearchEntry({
                placeholder_text: __('Search applications…'),
            });
            this._searchEntry.connect('search-changed', () => this._rebuildAppList());
            content.append(this._searchEntry);

            this._appList = new Gtk.ListBox({
                selection_mode: Gtk.SelectionMode.NONE,
                css_classes: ['boxed-list'],
                valign: Gtk.Align.START,
            });
            content.append(new Gtk.ScrolledWindow({
                child: this._appList,
                vexpand: true,
                hscrollbar_policy: Gtk.PolicyType.NEVER,
            }));
            this._rebuildAppList();
        }

        const toolbarView = new Adw.ToolbarView({content});
        toolbarView.add_top_bar(headerBar);
        this.set_content(toolbarView);
    }

    _rebuildAppList() {
        this._appList.remove_all();

        const query = this._searchEntry.get_text().toLowerCase().trim();
        const apps = this._installedApps.filter(app => !query ||
            app.name.toLowerCase().includes(query) ||
            app.id.toLowerCase().includes(query));

        // Selected apps first
        apps.sort((a, b) =>
            this._selectedApps.has(b.id) - this._selectedApps.has(a.id));

        apps.forEach(app => {
            const check = new Gtk.CheckButton({
                active: this._selectedApps.has(app.id),
                valign: Gtk.Align.CENTER,
            });
            check.connect('toggled', () => {
                if (check.active)
                    this._selectedApps.add(app.id);
                else
                    this._selectedApps.delete(app.id);
            });

            const row = new Adw.ActionRow({title: GLib.markup_escape_text(app.name, -1)});
            // Prefixes are packed from the end
            if (app.icon)
                row.add_prefix(new Gtk.Image({gicon: app.icon, pixel_size: 24}));
            row.add_prefix(check);
            row.set_activatable_widget(check);
            this._appList.append(row);
        });
    }

    _save() {
        const name = this._nameRow.get_text().trim();
        if (!name) {
            this._nameRow.add_css_class('error');
            return;
        }

        this._group.name = name;
        this._group.color = hexFromRgba(this._colorButton.rgba);
        this._group.borderColor = hexFromRgba(this._borderColorButton.rgba);
        this._group.opacity = this._opacityRow.value;
        this._group.borderWidth = this._borderWidthRow.value;

        if (!this._isOtherGroup) {
            // Keep the existing order, append new apps
            this._group.apps = [
                ...this._group.apps.filter(id => this._selectedApps.has(id)),
                ...[...this._selectedApps].filter(id => !this._group.apps.includes(id)),
            ];
        }

        this._onSave(this._group);
        this.close();
    }
});

/**
 * The "Groups" settings tab
 */
const GroupsPage = GObject.registerClass(
class GroupsPage extends Gtk.Box {
    _init(settings) {
        super._init({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 24,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });

        this._settings = settings;
        this._installedApps = null;

        const generalGroup = new Adw.PreferencesGroup({
            title: __('Application groups'),
            description: __('Organize the dock applications in named, collapsible groups. ' +
                'Click on a group header in the dock to collapse or expand it, ' +
                'drag icons to move them between groups.'),
        });
        this.append(generalGroup);

        const addSwitch = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, ...subtitle ? {subtitle} : {}});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            generalGroup.add(row);
            return row;
        };
        addSwitch('enable-groups', __('Organize applications in groups'));
        const ungroupedRow = addSwitch('show-ungrouped', __('Show ungrouped applications'),
            __('Applications that are not part of any group are shown in the "Other" group'));
        settings.bind('enable-groups', ungroupedRow, 'sensitive', Gio.SettingsBindFlags.GET);

        const styleGroup = new Adw.PreferencesGroup({title: __('Group appearance')});
        this.append(styleGroup);
        settings.bind('enable-groups', styleGroup, 'sensitive', Gio.SettingsBindFlags.GET);

        const addSpin = (key, title, max) => {
            const row = Adw.SpinRow.new_with_range(0, max, 1);
            row.title = title;
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            styleGroup.add(row);
        };
        addSpin('group-header-size', __('Header size'), 64);
        addSpin('group-spacing', __('Space between groups'), 48);
        addSpin('group-corner-radius', __('Corner radius'), 50);

        const addButton = new Gtk.Button({
            child: new Adw.ButtonContent({
                icon_name: 'list-add-symbolic',
                label: __('Add Group'),
            }),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => this._editGroup(null));

        this._groupsGroup = new Adw.PreferencesGroup({
            title: __('Groups'),
            description: __('Groups are shown in the dock in this order.'),
            header_suffix: addButton,
        });
        this.append(this._groupsGroup);
        settings.bind('enable-groups', this._groupsGroup, 'sensitive',
            Gio.SettingsBindFlags.GET);

        this._groupsList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        this._groupsGroup.add(this._groupsList);

        const changedId = settings.connect('changed::app-groups', () => this._populate());
        this.connect('destroy', () => settings.disconnect(changedId));
        this._populate();
    }

    get installedApps() {
        this._installedApps ??= Gio.AppInfo.get_all().filter(info => info.should_show())
            .map(info => ({
                id: info.get_id(),
                name: info.get_display_name(),
                icon: info.get_icon(),
            }));
        return this._installedApps;
    }

    _getGroups() {
        return AppGroups.parseGroups(this._settings.get_string('app-groups'));
    }

    _setGroups(groups) {
        this._settings.set_string('app-groups', AppGroups.serializeGroups(groups));
    }

    _populate() {
        this._groupsList.remove_all();

        const groups = this._getGroups();
        groups.forEach((group, index) => {
            const isOther = AppGroups.isOtherGroup(group);
            const nApps = group.apps.length;
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(group.name || __('Unnamed Group'), -1),
                subtitle: isOther ? __('Ungrouped applications')
                    : ngettext('%d application', '%d applications', nApps)
                        .replace('%d', nApps),
            });

            const swatch = new Gtk.DrawingArea({
                content_width: 24,
                content_height: 24,
                valign: Gtk.Align.CENTER,
            });
            swatch.set_draw_func((_area, cr, width, height) => {
                const fill = rgbaFromHex(group.color);
                const stroke = rgbaFromHex(group.borderColor);
                cr.arc(width / 2, height / 2, 10, 0, 2 * Math.PI);
                cr.setSourceRGBA(fill.red, fill.green, fill.blue, 1);
                cr.fillPreserve();
                cr.setSourceRGBA(stroke.red, stroke.green, stroke.blue, 1);
                cr.setLineWidth(2);
                cr.stroke();
                cr.$dispose();
            });
            row.add_prefix(swatch);

            const addButton = (iconName, tooltip, sensitive, callback) => {
                const button = new Gtk.Button({
                    icon_name: iconName,
                    tooltip_text: tooltip,
                    sensitive,
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                button.connect('clicked', callback);
                row.add_suffix(button);
                return button;
            };
            addButton('document-edit-symbolic', __('Edit group'), true,
                () => this._editGroup(group));
            addButton('go-up-symbolic', __('Move up'), index > 0,
                () => this._moveGroup(index, -1));
            addButton('go-down-symbolic', __('Move down'), index < groups.length - 1,
                () => this._moveGroup(index, 1));
            addButton('user-trash-symbolic',
                isOther ? __('The "Other" group cannot be deleted') : __('Delete group'),
                !isOther, () => this._deleteGroup(group.id));

            this._groupsList.append(row);
        });
    }

    _editGroup(group) {
        const editor = new GroupEditorWindow(this.get_root(), group, this.installedApps,
            savedGroup => {
                const groups = this._getGroups();
                const index = groups.findIndex(g => g.id === savedGroup.id);

                // An app can belong to a single group
                if (!AppGroups.isOtherGroup(savedGroup)) {
                    groups.forEach(g => {
                        if (g.id !== savedGroup.id)
                            g.apps = g.apps.filter(id => !savedGroup.apps.includes(id));
                    });
                }

                if (index >= 0) {
                    groups[index] = savedGroup;
                } else {
                    // New groups are added before the "Other" group
                    const otherIndex = groups.findIndex(AppGroups.isOtherGroup);
                    groups.splice(otherIndex >= 0 ? otherIndex : groups.length, 0, savedGroup);
                }

                this._setGroups(groups);
            });
        editor.present();
    }

    _moveGroup(index, direction) {
        const groups = this._getGroups();
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= groups.length)
            return;

        [groups[index], groups[newIndex]] = [groups[newIndex], groups[index]];
        this._setGroups(groups);
    }

    _deleteGroup(groupId) {
        this._setGroups(this._getGroups().filter(g => g.id !== groupId));
    }
});

export default class DockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = new DockSettings(this);
        window.add(settings.page);
    }
}
