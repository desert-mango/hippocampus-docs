## What it is

A replication and extension of Cai, Chang, and Girdhar's published *Learning to Swim*
reinforcement-learning pipeline for thruster-driven AUV control. The original research and
released `warplab/isaac-auv-env` implementation define the pipeline; this project tests its
reproducibility and vehicle-specific behavior rather than claiming that upstream work.

## What was built and tested

- Reproduced the CUREE simulation pipeline through a policy that passed the project's two
  registered success bars.
- Derived vehicle parameters, thruster-allocation checks, fidelity audits, campaign tooling,
  and offline evaluation for HippoCampus and BlueROV2 Heavy simulation arms.
- Ran nine stock four-thruster HippoCampus campaigns on a reduced position-and-pointing task.
  Pointing often passed, while position remained the binding failure across all campaigns.

## Where it stands

The simulation replication and analysis are complete enough to expose both positive and
negative results. The work has not established transfer to either physical vehicle, and it
does not present simulated control performance as a hardware result.

## Simulation run guide

### What the guide runs

This guide runs one simulated HippoCampus flight and tells you how to see that it worked.

A **simulation** is a program that stands in for the robot. Here it flies a short course in the
pool, the "heat course" (a path past warm spots on the floor). A **controller** is the code that
decides the four motor commands at each step. Nothing in this guide sends a command to a real
motor, ESC (the motor's speed controller), I2C bus, GPIO pin or serial port.

The controllers sit in a **chain**: a list tried in order. The first one that loads flies. If it
misbehaves during the flight (an error, a command out of range, or a tilt past 35° for half a
second), the next one takes over, and the log says why. Today the chain is:

1. `slot`: an empty place for a future controller. It is skipped.
2. `teacher012`: the hand-tuned controller from campaign 012. This is the one that flies.
3. `level010`: the frozen controller from campaign 010.
4. `safe_stop`: zero thrust.

The simulation has run many times on a Mac. It has **not yet run on the robot's own Raspberry
Pi**. The last section shows how to do that.

<div class="adm adm-warning"><p class="adm-title">Props off anyway</p>

The code has no motor output, and a self-check proves it. Still take the propellers off before
you run anything on the vehicle's Pi.

</div>

### Before you run it

- **Access to the code.** It lives in a private GitHub repository,
  `kyle-nelson-berkeley/learning-to-swim-replication`. Ask Kyle Nelson to add your GitHub
  username.
- **Python 3.10 or newer**, with NumPy 1.24 or newer and PyYAML. No GPU, no ROS, no Isaac Sim.
- **Time.** One flight takes about 10 to 15 seconds on a laptop. The full check takes about
  1.5 minutes. A Pi will be slower.

### Run one simulation on a computer

Run these from any folder. The first command copies the code to your computer:

```console
$ git clone https://github.com/kyle-nelson-berkeley/learning-to-swim-replication.git
$ cd learning-to-swim-replication
```

Make a **virtual environment** (a private Python folder for this project, so nothing else on the
computer changes) and add the two libraries. The run script uses this folder on its own when it
exists:

```console
$ python3 -m venv HIPPOCAMPUS/.venv
$ HIPPOCAMPUS/.venv/bin/pip install numpy pyyaml
```

Check which controllers load:

```console
$ HIPPOCAMPUS/pi-launch/run_heat_sim.sh check
```

It worked if the output lists `teacher012`, `level010` and `safe_stop` as `LOADED`, says
`SKIPPED slot ... slot empty (no slot.json)`, and ends with:

```text
FIRST   teacher012
```

Now fly one simulation. A **seed** is the number that fixes the random parts of a run, so the
same seed gives the same flight:

```console
$ HIPPOCAMPUS/pi-launch/run_heat_sim.sh fly --chain --seeds 4007185 --out /tmp/heat-one
```

It worked if you see this row (the timing numbers in the middle will differ on your computer):

```text
chain>teacher012  4007185  PASS               PASS           19.5    ...      0  -
```

and a last line that says `wrote /tmp/heat-one/flights.json`. Read the row like this:

- `chain>teacher012`: the chain flew the first controller, as it should.
- The first `PASS` is what Kyle's Mac recorded for this seed. The second `PASS` is your run. **The
  two must match.**
- `19.5` is the largest tilt in degrees.
- `0` is the number of times the chain fell to the next controller. It should be `0`.
- `-` means no scoring rule failed.

The full numbers for every rule are in `/tmp/heat-one/flights.json`.

### The full check (optional)

With no arguments the script runs the check, flies every controller on its own over three seeds,
then flies the chain over the same seeds:

```console
$ HIPPOCAMPUS/pi-launch/run_heat_sim.sh
```

It saves everything in `~/heat-launch-results/<time>/` (`run.log`, `each/`, `chain/`) and prints
that folder at the end. Some rows say `FAIL`. **That is expected**: those flights also failed when
they were first recorded. A run is broken only when the two result columns disagree, or when
`falls` is not `0`. On the Mac the second result column (your run) was:

| Controller | 4007184 | 4007185 | 4007186 |
|---|---|---|---|
| `teacher012` | FAIL | PASS | PASS |
| `level010` | FAIL | FAIL | FAIL |
| `safe_stop` | FAIL | FAIL | FAIL |
| `chain>teacher012` | FAIL | PASS | PASS |

`safe_stop` is the one exception to "the columns must match": it has no recorded result, so its
first column shows `-`. It always fails, on purpose, because it never moves the vehicle.

### Run it on the robot's Raspberry Pi

This copies a small, sealed package (a **bundle**) to the Pi and runs the same simulation there.
The Pi only needs Python 3.10 or newer, NumPy and PyYAML. **SSH** is how you log in to the Pi
from your computer over the network.

On your computer, inside the cloned folder, build the bundle and copy it over. These four commands
come from the repository's own `HIPPOCAMPUS/pi-launch/README.md`; change `pi@hippo-main-01.local`
if your Pi has another user or name:

```console
$ HIPPOCAMPUS/pi-launch/build_bundle.sh /tmp/out
$ scp /tmp/out/heat-launch-bundle-*.tar.gz pi@hippo-main-01.local:
$ ssh pi@hippo-main-01.local 'tar -xzf heat-launch-bundle-*.tar.gz && heat-launch/pi-launch/pi_check.sh'
$ ssh pi@hippo-main-01.local 'heat-launch/pi-launch/run_heat_sim.sh'
```

The third command runs a read-only self-check. It changes nothing on the Pi and prints one line
per check. It worked if the last line says `0 FAIL`. On a Mac dry run it said:

```text
summary: 9 PASS, 0 FAIL, 13 INFO (replay lines are informational)
```

A Pi checks more lines, so its counts will differ; the `0 FAIL` is what matters. Lines marked
`INFO` are notes, not problems. If a line says `FAIL`:

- `numpy>=1.24` or `pyyaml`: the line prints its own fix, for example
  `sudo apt install python3-numpy` or `sudo apt install python3-yaml`.
- `no_motor_process_running`: a motor program (MAVROS, PX4, a `ros2 launch`) is running. Stop it
  first.
- `identity.hostname`, `identity.eth0_mac` or `identity.ssh_hostkey`: the check compares the Pi
  with `hippo-main-01`. On another Pi these three lines fail. That only means it is a different
  Pi.
- `clock.ntp_synchronized`: the Pi's clock is not set from the network. The line itself says
  this only affects timestamps and is not needed for the simulation.

The fourth command is the full check from the section above, now on the Pi. Judge it the same
way: the two result columns must match, and `falls` must be `0`. Please send Kyle the `run.log`
from the results folder it prints, so the Pi result is on record.

### What this does not show

- It is not a test of the real vehicle in water. The simulation stands in for the vehicle.
- The controller that flies is hand-tuned, not a trained network. The `slot` for a trained
  network is still empty (`HIPPOCAMPUS/pi-launch/slots/README.md` says how to fill it).
- A Pi run shows the code runs on the Pi and gives the same answers. It says nothing yet about
  the vehicle's real motors.
