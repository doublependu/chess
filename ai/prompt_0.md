
Make a classic chess game: https://en.wikipedia.org/wiki/Chess

Write an AI player in client javascript whose difficulty level automatically adjust based on how good the human player is. 
    - regardless of how good the human player is, give him or her a chance to win but don't make it too easy

Chess pieces are animated
1. idle
2. move (jump for horse)
3. attack
4. being destroyed

use three.js for rendering 3D models in animation style

use destructable 3D models with fracturing, and a physics engine to simulate the destruction of chess pieces, make it dramatic

The destroyed pieces of chess pieces are blown away by a gust of wind

Create a 3D background environment where the chess battle happens in. 

Add 3 checkpoint slots
1. human player can save the game into those slots and get back to it later
2. when he decides to load one of the checkpoints, 
    - create an animation that shows the reverse of time: 
        - fractured chess pieces get put back together
        - move and attack animations played backward



# General

- Loading page and pause screen should have a "fork me on github" link to encourage adaptation
- For now, the project should be deployed as a static website
- Prepare the project to deploy on cloudflare using wrangler with preview url = false
- Show the game's version in an unused corner of the game. 
    - template: "v.<first 4 letters of the deployed git commit>"
- If the project allows, use responsive design and make sure to use the full screen on both PC and mobile with different screen sizes and aspect ratio 
    - mobile: mid-game, transition between horizontal and vertical screen should work without incorrect scaling
    - mobile: if possible, should stop touch-based zooms that the user can't zoom back out
- Should write scripts to play the game as a human player
    - make sure the game is balanced and fun for a human player
    - record the gameplay for reference but don't commit the recordings
    - use this to improve the gameplay and reduce bugs


