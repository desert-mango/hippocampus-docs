# Deployment


We have 2 BlueROV2s:


- The old BlueROV. We use it mainly for the SEMS/FAV class. It's vehicle name is `bluerov01`.

- The newer BlueROV. This one is used for the UVMS setup and has the Alpha arm mounted to it. It's vehicle name is `bluerov02`.


<div class="adm adm-todo"><p class="adm-title">To do</p>

This section is still work in progress.




</div>

## SSH Access


For convenience, you can copy your ssh-key to the BlueROV to enable passwordless login and create an entry in your `~/.ssh/config` for the BlueROV similar to:


<div class="tabs">

<div class="tab" data-label="Pi in upper tube">

```sh
Host klopsi-main-01
    User pi
    Hostname klopsi-main-01.local
    IdentitiyFile "~/.ssh/id_ed25519"
```

</div>

<div class="tab" data-label="Pi in lower tube">

```sh
Host klopsi-buddy-01
    User pi
    Hostname klopsi-buddy-01.local
    IdentitiyFile "~/.ssh/id_ed25519"
```

</div>


</div>

<div class="adm adm-note"><p class="adm-title">Note</p>

Replace the path for the identity file with the name of your key.



</div>

This entry allows you to use `ssh klopsi-main-01` instead of `ssh pi@klopsi-main-01.local`.


## Start the usual Setup


### Automated start of nodes (bluerov01)


For the `bluerov01`, we currently use an automated setup, where all necessary nodes are started at booting.


Make sure you have read and understood [Automated Deployment](#/setup/concepts/deployment).



### Manual start of nodes (bluerov02)



<div class="tabs">

<div class="tab" data-label="klopsi-main-01">

```console
$ ros2 launch hardware bluerov.launch.py vehicle_name:=bluerov01
```

</div>

<div class="tab" data-label="klopsi-buddy-01">

```console
$ ros2 launch hardware bluerov_buddy.launch.py vehicle_name:=bluerov01
```

</div>


</div>


<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/bluerov/deploy.html">contents/bluerov/deploy</a>.</p>
