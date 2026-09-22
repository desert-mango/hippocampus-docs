## What it is

![A small orange four-thruster underwater robot hovering in a long rectangular concrete water tank](https://res.cloudinary.com/dr76gues0/image/upload/v1790120325/hippocampus-docs/projects/ul_hero_vehicle_in_pool.jpg)

A small underwater robot in a water tank, and the code that works out where it is. The robot
compares what its sensors read with a stored plan of the tank. Anything the stored plan cannot
explain goes into a separate layer, so the plan itself is never edited.

Known-map localization and environment-change mapping for underwater robots, followed by
a temperature-guided exploration phase. The shared Python core matches range observations
against a fixed tank map and records persistent disagreement in a separate change layer.

## How it works

![Four range pings feed a particle filter, which compares them with the fixed reference map to produce a pose estimate, while unexplained readings go to a separate change layer](https://res.cloudinary.com/dr76gues0/image/upload/v1790120327/hippocampus-docs/projects/ul_localization_loop.png)

Once a second the robot takes four distance readings. A particle filter keeps 3000 guesses of
its own position and heading, and the guesses that fit the readings survive. The estimate is
their weighted average.

The stored tank is a file, and no run edits it. That rule is what makes the separate change
layer meaningful rather than decorative.

## What Kyle built and tested

- A particle-filter localization pipeline and 3D occupancy/change representation that run
  without ROS 2, with ROS 2 and Gazebo kept behind integration boundaries.
- Reproducible HippoCampus experiments in the measured TUHH pool simulation, including a
  new-object test and temperature exploration around scattered floor sources.
- Evaluation ledgers that report wall-voxel contacts, filter quality, coverage, classifier
  evidence, and model limitations instead of turning simulation results into hardware claims.

## What the experiments show

![A top-down view of the pool with the true track in red and the filter's estimated track in blue, ending close together](https://res.cloudinary.com/dr76gues0/image/upload/v1790120322/hippocampus-docs/projects/ul_001_top_down_pool.png)

The filter tracks the vehicle through the measured pool, and a board placed in the tank turns
up as new occupied space rather than as an edit to the map.

![The pool floor drawn cell by cell, with the declared floor cells in blue and the four planted hot blocks in red](https://res.cloudinary.com/dr76gues0/image/upload/v1790120323/hippocampus-docs/projects/ul_004_declared_space.png)

The temperature phase sweeps a set of floor cells declared before the run, finds each planted
heat source in the cell it was planted in, and labels how each one heats. Coverage is claimed
over those declared cells, never over the whole tank.

## What is not claimed

![Two lists: what the onboard packet carries, and what it does not carry](https://res.cloudinary.com/dr76gues0/image/upload/v1790120324/hippocampus-docs/projects/ul_005_inputs.png)

The newest experiment flies on an inertial sensor and a pressure sensor alone, with no true
position and no range reading. Its heat mission verdict is NO-GO: there is no trained
controller, and position worked out from those inputs drifts past the bound the mission needs.

The scattered-source mission prints its own certification guarantee as BROKEN, because the
filter's position error runs past the declared allowance. Two learned controllers were also
benchmarked against a standard written down before any flight, and neither met it. Both
results are published rather than smoothed over.

## Where it stands

Known-map localization and temperature exploration have been demonstrated in simulation.
The current bottleneck is position error in the filter. Collision results apply to the
vehicle reference point because a body radius and safety margin are not yet modeled; no
hardware-transfer claim is made.

## Reading the repository

The repository's own starting point is `docs/start-here.md`, a ten-minute plain-English guide.
Each experiment keeps a full report next to its code under `vehicles/HIPPOCAMPUS/experiments/`,
including what it does not prove. Every document a newcomer needs in order to read the code and
set it up opens with a short plain section and a picture.
