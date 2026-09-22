# Setup

This section gets you from a blank machine to a running robot or simulation. It replaces
the old Sphinx docs site page for page — the parity table
lives in this repository at `docs/setup-parity.md`.

## Where to start

1. **New workstation?** Start with [ROS installation](#/setup/getting-started/ros-installation)
   and work through *Getting started* in order — each page ends where the next begins.
2. **Setting up a vehicle computer?** Go to [Raspberry Pi setup](#/setup/raspberry-pi/quality-of-life).
3. **Bringing up a HippoCampus?** After the Pi, follow
   [HippoCampus bring-up](#/setup/hippocampus-bringup/motor-configuration).
4. **Working with the BlueROV?** See the [BlueROV](#/setup/bluerov/build-and-flash) group.
5. **Just need a concept explained?** [Concepts](#/setup/concepts/ros2-workspace) covers
   workspaces, colcon, packages, and deployment — read those before your first build error,
   not after.

## How these pages work

- Steps are numbered and chronological; run them top to bottom.
- Boxes marked **Warning** or **Attention** are load-bearing — read them before the command above them.
- Tabs (for example *desktop-full* vs *perception*) pick a variant; choose one and stay with it.
- Every page footer links the page it was migrated from, so you can always compare against
  the old site.

## The lab systems

Qualisys motion capture, the gantry, cameras, reflective markers, and time synchronization
have their own groups in the sidebar — they matter once your vehicle is in the tank.
