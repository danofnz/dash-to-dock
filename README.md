# Dash to Dock with Groups
![screenshot](media/screenshot.jpg)

## A dock for the GNOME Shell, with application groups
This extension enhances the dash moving it out of the overview and transforming it in a dock for an easier launching of applications and a faster switching between windows and desktops without having to leave the desktop view.
On top of that, dock icons can be organized in named, color-coded, collapsible [groups](#application-groups).

Dash to Dock with Groups is a fork of [Dash to Dock](https://github.com/micheleg/dash-to-dock) by Michele,
with the grouping feature ported from [Multi-Column Dock](https://github.com/AITwinMinds/Multi-column-dock).
It is a separate extension (`dash-to-dock-with-groups@danofnz.github.io`) with its own settings,
so disable Dash to Dock (or Ubuntu Dock) before enabling it.

## Installation from source

The extension can be installed directly from source, either for the convenience of using git or to test the latest development version. Clone the desired branch with git

### Build Dependencies

To compile the stylesheet you'll need an implementation of SASS. Dash to Dock with Groups supports `dart-sass` (`sass`), `sassc`, and `ruby-sass`. Every distro should have at least one of these implementations, we recommend using `dart-sass` (`sass`) or `sassc` over `ruby-sass` as `ruby-sass` is deprecated.

By default, Dash to Dock with Groups will attempt to build with `sassc`. To change this behavior set the `SASS` environment variable to either `dart` or `ruby`.

```bash
export SASS=dart
# or...
export SASS=ruby
```

### Building

Clone the repository or download the branch from github. A simple Makefile is included.

Next use `make` to install the extension into your home directory. A Shell reload is required <kbd>Alt</kbd> + <kbd>F2</kbd> <kbd>r</kbd> <kbd>Enter</kbd> under Xorg or under Wayland you may have to logout and login. The extension has to be enabled  with *gnome-extensions-app* (GNOME Extensions) or with *dconf*.

```bash
git clone https://github.com/danofnz/dash-to-dock.git dash-to-dock-with-groups
make -C dash-to-dock-with-groups install
```

If `msgfmt` is not available on your system, you will see an error message like the following:

```bash
make: msgfmt: No such file or directory
```

In this case install the `gettext` package from your distribution's repository.


## Application groups

Dock icons can be organized in named, color-coded groups, a feature ported
from [Multi-Column Dock](https://github.com/AITwinMinds/Multi-column-dock).
Enable it and manage the groups from the *Groups* tab of the preferences:

- each group has a name, background and border colors, opacity and border width;
- click a group header in the dock to collapse or expand the group;
- drag icons in the dock to reorder them or move them to another group;
- applications that are not part of any group are shown in the *Other* group,
  in the favorites order (it can be hidden, renamed, restyled or moved, but not deleted).

Grouped applications appear in the dock only when they are pinned or running.
The `app-groups` setting uses the same JSON format as Multi-Column Dock, so a
configuration can be copied over with:

```bash
dconf write /org/gnome/shell/extensions/dash-to-dock-with-groups/app-groups \
    "$(dconf read /org/gnome/shell/extensions/multicolumndock/app-groups)"
```

## Bug Reporting

Bugs should be reported to the Github bug tracker [https://github.com/danofnz/dash-to-dock/issues](https://github.com/danofnz/dash-to-dock/issues).

## License
Dash to Dock with Groups Gnome Shell extension is distributed under the terms of the GNU General Public License,
version 2 or later. See the COPYING file for details.
