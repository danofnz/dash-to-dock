// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

/*
 * Application groups model, shared by the dock and the preferences.
 *
 * Groups are stored as a JSON array in the 'app-groups' setting, using the
 * same format as the Multi-Column Dock extension:
 *   {id, name, color, borderColor, borderWidth, opacity, collapsed, apps: []}
 *
 * The special group OTHER_GROUP_ID collects every application that is not part
 * of another group; its 'apps' list is never used, ungrouped applications keep
 * the favorites order instead.
 *
 * This module must not depend on Shell or Gtk libraries, as it's imported by
 * both sides.
 *
 * Derived from Multi-Column Dock, Copyright (c) 2025 Smart Coding & AI with
 * Aliiman, under the MIT license: see LICENSE-Multi-Column-Dock.
 */

export const OTHER_GROUP_ID = '__other__';

export const DEFAULT_GROUP = Object.freeze({
    name: '',
    color: '#2a2a2a',
    borderColor: '#444444',
    borderWidth: 1,
    opacity: 0.8,
    collapsed: false,
});

const DEFAULT_OTHER_GROUP = Object.freeze({
    ...DEFAULT_GROUP,
    id: OTHER_GROUP_ID,
    name: 'Other',
    color: '#333333',
    borderColor: '#555555',
    opacity: 0.6,
});

/**
 * @returns {string} a new unique group id
 */
export function generateGroupId() {
    return `group_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * @param {object} group
 * @returns {boolean} whether the group is the one collecting ungrouped apps
 */
export function isOtherGroup(group) {
    return group?.id === OTHER_GROUP_ID || !!group?.isOtherGroup;
}

/**
 * Parse the groups stored in the settings, dropping invalid entries and the
 * hidden internal groups that Multi-Column Dock may have stored, and ensuring
 * the "Other" group exists.
 *
 * @param {string} json the 'app-groups' setting value
 * @returns {object[]} the list of groups, in display order
 */
export function parseGroups(json) {
    let groups;
    try {
        groups = JSON.parse(json);
    } catch (e) {
        logError(e, 'Invalid app-groups setting');
    }

    if (!Array.isArray(groups))
        groups = [];

    groups = groups.filter(g => g && typeof g.id === 'string' && !g.hidden).map(g => ({
        ...DEFAULT_GROUP,
        ...g,
        apps: Array.isArray(g.apps) && !isOtherGroup(g)
            ? g.apps.filter(id => typeof id === 'string') : [],
    }));

    if (!groups.some(isOtherGroup))
        groups.push({...DEFAULT_OTHER_GROUP, apps: []});

    return groups;
}

/**
 * @param {object[]} groups
 * @returns {string} the serialized groups, to be stored in 'app-groups'
 */
export function serializeGroups(groups) {
    return JSON.stringify(groups.map(g => {
        const {isOtherGroup: _, ...group} = g;
        if (isOtherGroup(g))
            group.apps = [];
        return group;
    }));
}

/**
 * Move an application to a group, removing it from any other group.
 *
 * @param {object[]} groups the groups list, modified in place
 * @param {string} appId the application to move
 * @param {string} groupId the target group, OTHER_GROUP_ID to ungroup it
 * @param {number} position the index in the target group, -1 to append it
 */
export function moveAppToGroup(groups, appId, groupId, position = -1) {
    groups.forEach(g => (g.apps = g.apps.filter(id => id !== appId)));

    const target = groups.find(g => g.id === groupId);
    if (!target || isOtherGroup(target))
        return;

    if (position >= 0 && position < target.apps.length)
        target.apps.splice(position, 0, appId);
    else
        target.apps.push(appId);
}

/**
 * @param {string} hex a color in the #rrggbb format
 * @returns {{r: number, g: number, b: number}} the color components
 */
export function parseHexColor(hex) {
    const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex ?? '');
    if (!match)
        return {r: 51, g: 51, b: 51};

    const [r, g, b] = match.slice(1).map(c => parseInt(c, 16));
    return {r, g, b};
}
