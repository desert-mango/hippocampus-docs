## What it is

Known-map localization and environment-change mapping for underwater robots, followed by
a temperature-guided exploration phase. The shared Python core matches range observations
against a fixed tank map and records persistent disagreement in a separate change layer.

## What Kyle built and tested

- A particle-filter localization pipeline and 3D occupancy/change representation that run
  without ROS 2, with ROS 2 and Gazebo kept behind integration boundaries.
- Reproducible HippoCampus experiments in the measured TUHH pool simulation, including a
  new-object test and temperature exploration around scattered floor sources.
- Evaluation ledgers that report wall-voxel contacts, filter quality, coverage, classifier
  evidence, and model limitations instead of turning simulation results into hardware claims.

## Where it stands

Known-map localization and temperature exploration have been demonstrated in simulation.
The current bottleneck is position error in the filter. Collision results apply to the
vehicle reference point because a body radius and safety margin are not yet modeled; no
hardware-transfer claim is made.
